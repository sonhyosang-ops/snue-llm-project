// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/documents — 문서 목록(GET)과 PDF 업로드(POST) (관리자 전용)
//
// POST: 파일을 Supabase Storage에 저장하고 documents 테이블에 행을 하나 만든다.
//       여기서는 파일만 저장하고, 파싱·청크·임베딩 같은 색인 작업은 이어서 단계별로 호출하는
//       /api/admin/documents/[id]/ingest 가 맡는다(관리자 화면이 차례로 부른다).
// GET : 올린 문서들의 상태(색인 중 / 준비됨 / 실패 / 운영 중)와 장 수를 돌려준다.
//       관리자는 이 목록에서 새 판을 "운영에 적용"하거나 이전 판으로 되돌린다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    // chapters(count)는 문서마다 연결된 장의 수를 함께 세어 오는 Supabase(PostgREST) 문법이다.
    const { data, error } = await serviceSupabase()
      .from("documents")
      .select("id, title, year, status, error, is_active, created_at, processed_at, chapters(count)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const documents = (data ?? []).map(({ chapters, ...document }) => ({ ...document, chapterCount: (chapters as unknown as { count: number }[])[0]?.count ?? 0 }));
    return Response.json({ documents });
  } catch (error) {
    return errorResponse(error);
  }
}

// 업로드 크기 상한(30MB). 너무 큰 파일은 서버 함수 메모리와 처리 시간을 넘길 수 있다.
const MAX_FILE_SIZE = 30 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    // 화면에서 FormData로 보낸 파일과 제목을 꺼내 검사한다.
    const form = await request.formData();
    const file = form.get("file");
    const title = String(form.get("title") ?? "").trim();
    const year = String(form.get("year") ?? "2025").trim();
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) throw new Error("PDF 파일만 업로드할 수 있습니다.");
    if (file.size > MAX_FILE_SIZE) throw new Error("PDF는 30MB 이하만 업로드할 수 있습니다.");
    if (!title) throw new Error("문서 제목을 입력하세요.");

    // 1) 문서 행을 먼저 만든다. 파일 저장 경로에 문서 id를 쓰기 위해서다(아직 경로를 모르므로 "pending").
    const supabase = serviceSupabase();
    const { data: document, error: insertError } = await supabase
      .from("documents")
      .insert({ title, year, storage_path: "pending", created_by: admin.id })
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
