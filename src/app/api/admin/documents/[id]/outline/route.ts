// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/documents/[id]/outline — 목차 확인과 확정 (색인 2단계, 관리자 전용)
//
// 색인 1단계(ingest step "outline")가 만든 "목차 초안"을 관리자가 확인·수정한 뒤 확정한다.
//   GET  : 초안(목차 항목·쪽 번호 보정값), PDF 쪽수, 이미 확정된 장 목록, 원본 PDF를 여는 임시 주소를 돌려준다.
//          임시 주소 끝에 #page=N을 붙이면 브라우저 PDF 보기에서 그 쪽이 바로 열려, 시작 쪽이 맞는지 확인할 수 있다.
//   POST : 관리자가 확정한 장 목록 { chapters: [{ number, title, pageFrom }] }을 검사해 chapters 테이블에 저장한다.
//          pageFrom은 실제 PDF 쪽 번호다(화면에서 목차의 인쇄 쪽 + 보정값으로 계산해 보낸다).
//          저장 후 상태는 processing이 되고, 화면이 이어서 장별 본문·핵심어 단계를 실행한다.
// 장을 사람이 확정하는 이유: 매뉴얼마다 목차 형식("제 N 장", "Ⅰ.", "1.")과 쪽 번호 방식이 달라
// 모델이 장을 잘못 나눌 수 있고, 장이 잘못되면 그 뒤의 청크·핵심어·장 안내가 모두 어긋나기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";
import type { ConfirmedChapter, OutlineDraft } from "@/lib/types";

type Params = { params: Promise<{ id: string }> };

// 확정할 수 있는 문서인지 확인한다. 색인이 끝난(ready·운영 중) 문서는 장을 바꿀 수 없다(질문 기록·되돌리기 보존).
async function loadEditableDocument(id: string) {
  const { data, error } = await serviceSupabase().from("documents")
    .select("id, title, storage_path, status, is_active, outline_draft, page_count").eq("id", id).single();
  if (error) throw error;
  if (data.is_active || data.status === "ready") throw new Error("색인이 끝난 문서는 목차를 바꿀 수 없습니다. 새 PDF로 올려 주세요.");
  return data;
}

export async function GET(request: Request, { params }: Params) {
  try {
    await requireAdmin(request);
    const { id } = await params;
    const supabase = serviceSupabase();
    const document = await loadEditableDocument(id);
    // 비공개 버킷의 PDF를 1시간 동안만 열 수 있는 임시 주소(서명된 URL)를 만든다. 주소가 새어 나가도 1시간 뒤 쓸 수 없다.
    const { data: signed, error: signedError } = await supabase.storage.from("personnel-pdfs").createSignedUrl(document.storage_path, 60 * 60);
    if (signedError) throw signedError;
    const { data: chapters, error: chaptersError } = await supabase.from("chapters")
      .select("id, title, chapter_number, page_from, page_to").eq("document_id", id).order("display_order");
    if (chaptersError) throw chaptersError;
    return Response.json({
      title: document.title,
      status: document.status,
      pageCount: document.page_count,
      draft: (document.outline_draft ?? { offset: 0, items: [] }) as OutlineDraft,
      chapters: chapters ?? [],
      pdfUrl: signed.signedUrl,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    await requireAdmin(request);
    const { id } = await params;
    const document = await loadEditableDocument(id);
    if (!document.page_count) throw new Error("목차 분석(1단계)을 먼저 실행하세요.");
    const pageCount = document.page_count;
    const { chapters: input } = await request.json() as { chapters?: ConfirmedChapter[] };

    // 화면이 보낸 장 목록을 서버에서 다시 검사한다(화면 검사는 우회될 수 있다).
    //   - 장이 하나 이상, 200개 이하
    //   - 제목이 비어 있지 않음
    //   - 시작 쪽이 1 ~ PDF 쪽수 사이의 정수이고, 앞 장보다 뒤에 있음(차례대로 커짐)
    //   - 번호가 적힌 장끼리는 번호가 겹치지 않음
    const chapters = (input ?? []).map((chapter) => ({ number: String(chapter.number ?? "").trim(), title: String(chapter.title ?? "").trim(), pageFrom: Number(chapter.pageFrom) }));
    if (!chapters.length || chapters.length > 200) throw new Error("장은 1개 이상 200개 이하로 확정해야 합니다.");
    const numbers = new Set<string>();
    chapters.forEach((chapter, index) => {
      const label = `${index + 1}번째 장`;
      if (!chapter.title) throw new Error(`${label}의 제목이 비어 있습니다.`);
      if (!Number.isInteger(chapter.pageFrom) || chapter.pageFrom < 1 || chapter.pageFrom > pageCount) throw new Error(`${label}('${chapter.title}')의 시작 쪽이 1~${pageCount} 범위를 벗어났습니다.`);
      if (index > 0 && chapter.pageFrom <= chapters[index - 1].pageFrom) throw new Error(`${label}('${chapter.title}')의 시작 쪽이 앞 장보다 앞이거나 같습니다.`);
      if (chapter.number && numbers.has(chapter.number)) throw new Error(`장 번호 '${chapter.number}'가 두 번 있습니다.`);
      if (chapter.number) numbers.add(chapter.number);
    });

    // 각 장은 다음 장 시작 바로 앞 쪽에서 끝나고, 마지막 장은 문서 끝까지다.
    // 첫 장 앞의 쪽(표지·목차)은 어느 장에도 넣지 않는다(검색할 본문이 아니므로).
    const supabase = serviceSupabase();
    const { error: deleteError } = await supabase.from("chapters").delete().eq("document_id", id);
    if (deleteError) throw deleteError;
    const { error: insertError } = await supabase.from("chapters").insert(chapters.map((chapter, display_order) => ({
      document_id: id,
      chapter_number: chapter.number,
      title: chapter.title,
      page_from: chapter.pageFrom,
      page_to: (chapters[display_order + 1]?.pageFrom ?? pageCount + 1) - 1,
      display_order,
    })));
    if (insertError) throw insertError;
    const { error: statusError } = await supabase.from("documents").update({ status: "processing", error: null }).eq("id", id);
    if (statusError) throw statusError;
    const { data: saved, error: savedError } = await supabase.from("chapters")
      .select("id, title, chapter_number, page_from, page_to").eq("document_id", id).order("display_order");
    if (savedError) throw savedError;
    return Response.json({ chapters: saved ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
