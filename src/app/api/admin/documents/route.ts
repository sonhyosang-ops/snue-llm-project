// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/documents — 문서(매뉴얼의 판) 목록(GET)과 PDF 업로드(POST) (관리자 전용)
//
// POST: 브라우저가 Storage에 직접 올린 PDF(upload-url 참고)가 실제로 있는지 확인하고 documents 테이블에 행을 하나 만든다.
//       어느 매뉴얼의 판인지 함께 정한다: 기존 매뉴얼(manualId)의 새 판, 또는 새 매뉴얼(newManualTitle) 추가.
//       (2026-11-08 변경: 예전에는 이 API가 파일 자체를 받아 Storage에 올렸는데, Vercel 서버 함수의 요청 크기 제한 4.5MB에
//        걸려 큰 편람 PDF가 413으로 거절됐다. 지금은 파일이 Vercel을 거치지 않고, 이 API는 등록만 한다.)
//       목차 초안·본문·핵심어 같은 색인 작업은 이어서 단계별로 호출하는 /api/admin/documents/[id]/ingest·/outline 이 맡는다.
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

// 업로드 크기 상한(30MB). 너무 큰 파일은 색인 단계(PDF 파싱)의 서버 함수 메모리와 처리 시간을 넘길 수 있다. 화면에서도 같은 값으로 먼저 거른다.
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

// 브라우저가 올렸다고 한 경로에 파일이 정말 있는지, 크기가 상한 안인지 Storage에서 확인한다.
// 경로는 upload-url이 만든 모양("<폴더>/source.pdf")만 받는다. 다른 문서의 폴더를 가리키는 값이 와도 그 파일을 "내 문서"로 등록할 수 없게 막는다.
async function verifyUploadedFile(supabase: ReturnType<typeof serviceSupabase>, storagePath: string) {
  const match = storagePath.match(/^([0-9a-f-]{36})\/source\.pdf$/);
  if (!match) throw new Error("업로드 경로가 올바르지 않습니다.");
  const { data: existing } = await supabase.from("documents").select("id").eq("storage_path", storagePath).maybeSingle();
  if (existing) throw new Error("이미 등록된 파일입니다.");
  const { data: objects, error } = await supabase.storage.from("personnel-pdfs").list(match[1]);
  if (error) throw error;
  const object = (objects ?? []).find((item) => item.name === "source.pdf");
  if (!object) throw new Error("올린 파일을 Storage에서 찾지 못했습니다. 다시 올려 주세요.");
  const size = Number((object.metadata as { size?: number } | null)?.size ?? 0);
  if (size > MAX_FILE_SIZE) {
    await supabase.storage.from("personnel-pdfs").remove([storagePath]);
    throw new Error("PDF는 30MB 이하만 등록할 수 있습니다.");
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    // 화면이 JSON으로 보낸 제목·판(연도)·매뉴얼·Storage 경로를 꺼내 검사한다(파일 자체는 오지 않는다).
    const body = await request.json() as { title?: string; year?: string; manualId?: string; newManualTitle?: string; storagePath?: string };
    const title = String(body.title ?? "").trim();
    const year = String(body.year ?? "").trim();
    const manualId = String(body.manualId ?? "").trim();
    const newManualTitle = String(body.newManualTitle ?? "").trim().slice(0, 100);
    const storagePath = String(body.storagePath ?? "").trim();
    if (!title) throw new Error("문서 제목을 입력하세요.");

    // 1) 파일이 실제로 올라와 있는지 확인한다. 없으면 문서 행을 만들지 않는다(파일 없는 문서가 DB에 남지 않게).
    const supabase = serviceSupabase();
    await verifyUploadedFile(supabase, storagePath);
    // 2) 매뉴얼을 정하고 문서 행을 만든다. 색인 API가 쓸 수 있도록 문서 id를 돌려준다.
    const resolvedManualId = await resolveManualId(supabase, manualId, newManualTitle);
    const { data: document, error: insertError } = await supabase
      .from("documents")
      .insert({ manual_id: resolvedManualId, title, year: year || null, storage_path: storagePath, created_by: admin.id })
      .select("id")
      .single();
    if (insertError) throw insertError;
    return Response.json({ id: document.id });
  } catch (error) {
    return errorResponse(error);
  }
}
