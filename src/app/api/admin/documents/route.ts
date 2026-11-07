// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/documents — 문서(매뉴얼의 판) 목록(GET)과 PDF 업로드(POST) (관리자 전용)
//
// POST: 파일을 Supabase Storage에 저장하고 documents 테이블에 행을 하나 만든다.
//       어느 매뉴얼의 판인지 함께 정한다: 기존 매뉴얼(manualId)의 새 판, 또는 새 매뉴얼(newManualTitle) 추가.
//       여기서는 파일만 저장하고, 목차 초안·본문·핵심어 같은 색인 작업은 이어서 단계별로 호출하는
//       /api/admin/documents/[id]/ingest·/outline 이 맡는다(관리자 화면이 차례로 부른다).
// GET : 매뉴얼 목록과, 올린 문서들의 상태(목차 확인 대기 / 색인 중 / 준비됨 / 실패 / 운영 중)·장 수를 돌려준다.
//       관리자는 이 목록에서 목차를 확인하고, 새 판을 "운영에 적용"하거나 이전 판으로 되돌린다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const supabase = serviceSupabase();
    // chapters(count)는 문서마다 연결된 장의 수를, manual:manuals(…)는 그 문서가 속한 매뉴얼을 함께 가져오는 문법이다.
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, year, status, error, is_active, created_at, processed_at, manual:manuals(id, title), chapters(count)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const documents = (data ?? []).map(({ chapters, manual, ...document }) => ({
      ...document,
      manual: manual as unknown as { id: string; title: string } | null,
      chapterCount: (chapters as unknown as { count: number }[])[0]?.count ?? 0,
    }));
    const { data: manuals, error: manualsError } = await supabase.from("manuals").select("id, title").order("display_order").order("title");
    if (manualsError) throw manualsError;
    return Response.json({ documents, manuals: manuals ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

// 업로드 크기 상한(30MB). 너무 큰 파일은 서버 함수 메모리와 처리 시간을 넘길 수 있다.
const MAX_FILE_SIZE = 30 * 1024 * 1024;

// 이 판이 속할 매뉴얼의 id를 정한다. 새 매뉴얼 제목이 오면 만들고(같은 제목이 이미 있으면 그것을 쓴다),
// 아니면 화면이 고른 기존 매뉴얼 id가 실제로 있는지 확인한다.
async function resolveManualId(supabase: ReturnType<typeof serviceSupabase>, manualId: string, newManualTitle: string) {
  if (newManualTitle) {
    const { data: existing, error: existingError } = await supabase.from("manuals").select("id").eq("title", newManualTitle).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return existing.id as string;
    // 새 매뉴얼은 사이드바 맨 아래에 오도록 지금까지의 매뉴얼 수 + 1을 순서로 준다.
    const { count } = await supabase.from("manuals").select("id", { count: "exact", head: true });
    const { data: created, error: createError } = await supabase.from("manuals").insert({ title: newManualTitle, display_order: (count ?? 0) + 1 }).select("id").single();
    if (createError) throw createError;
    return created.id as string;
  }
  if (!manualId) throw new Error("매뉴얼을 고르거나 새 매뉴얼 제목을 입력하세요.");
  const { data: manual, error } = await supabase.from("manuals").select("id").eq("id", manualId).maybeSingle();
  if (error) throw error;
  if (!manual) throw new Error("고른 매뉴얼을 찾을 수 없습니다.");
  return manual.id as string;
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    // 화면에서 FormData로 보낸 파일·제목·판(연도)·매뉴얼을 꺼내 검사한다.
    const form = await request.formData();
    const file = form.get("file");
    const title = String(form.get("title") ?? "").trim();
    const year = String(form.get("year") ?? "").trim();
    const manualId = String(form.get("manualId") ?? "").trim();
    const newManualTitle = String(form.get("newManualTitle") ?? "").trim().slice(0, 100);
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) throw new Error("PDF 파일만 업로드할 수 있습니다.");
    if (file.size > MAX_FILE_SIZE) throw new Error("PDF는 30MB 이하만 업로드할 수 있습니다.");
    if (!title) throw new Error("문서 제목을 입력하세요.");

    // 1) 매뉴얼을 정하고, 문서 행을 먼저 만든다. 파일 저장 경로에 문서 id를 쓰기 위해서다(아직 경로를 모르므로 "pending").
    const supabase = serviceSupabase();
    const resolvedManualId = await resolveManualId(supabase, manualId, newManualTitle);
    const { data: document, error: insertError } = await supabase
      .from("documents")
      .insert({ manual_id: resolvedManualId, title, year: year || null, storage_path: "pending", created_by: admin.id })
      .select("id")
      .single();
    if (insertError) throw insertError;

    // 2) 비공개 버킷 personnel-pdfs의 "<문서 id>/source.pdf"에 저장한다. 문서마다 폴더가 따로 생긴다.
    const storagePath = `${document.id}/source.pdf`;
    const { error: uploadError } = await supabase.storage.from("personnel-pdfs").upload(storagePath, file, { contentType: "application/pdf", upsert: false });
    if (uploadError) {
      // 파일 저장에 실패하면 방금 만든 문서 행도 지워, 파일 없는 문서가 DB에 남지 않게 한다.
      await supabase.from("documents").delete().eq("id", document.id);
      throw uploadError;
    }
    // 3) 실제 저장 경로를 문서 행에 기록하고, 색인 API가 쓸 수 있도록 문서 id를 돌려준다.
    const { error: updateError } = await supabase.from("documents").update({ storage_path: storagePath }).eq("id", document.id);
    if (updateError) throw updateError;
    return Response.json({ id: document.id });
  } catch (error) {
    return errorResponse(error);
  }
}
