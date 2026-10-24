// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chapters — 현재 활성 문서와 그 장 목록
//
// 로그인 직후 화면이 가장 먼저 부르는 API다. 응답의 role로 관리자 링크를 보여 줄지도 정한다.
// 문서는 여러 번 올릴 수 있지만, 사용자에게는 색인이 끝난(status=ready) 활성 문서 하나만 보여 준다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const supabase = serviceSupabase();
    // 활성 문서가 여러 개일 수 없지만, 만약을 위해 가장 최근에 처리된 것 하나만 고른다.
    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("id, title, year")
      .eq("is_active", true)
      .eq("status", "ready")
      .order("processed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (documentError) throw documentError;
    // 아직 색인된 문서가 없으면 빈 장 목록을 돌려준다(화면에 "활성화된 문서가 없습니다" 표시).
    if (!document) return Response.json({ role: user.role, document: null, chapters: [] });

    // 장 목록은 목차 순서(display_order)대로 보낸다.
    const { data: chapters, error } = await supabase
      .from("chapters")
      .select("id, title, chapter_number, page_from, page_to, display_order, document_id")
      .eq("document_id", document.id)
      .order("display_order");
    if (error) throw error;
    return Response.json({ role: user.role, document, chapters: chapters ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
