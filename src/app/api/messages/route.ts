// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages — 내 질문 기록(최근 20건)
//
// 질문할 때마다 /api/ask가 질문·답변·근거를 messages 테이블에 저장한다.
// 이 API는 그중 "로그인한 본인"의 기록만 최신순으로 돌려준다. 화면 왼쪽의 "최근 질문" 목록이 쓴다.
// 다른 사람의 기록은 절대 섞이지 않도록 서버에서 user_id로 거른다(브라우저가 보낸 값을 믿지 않고 토큰에서 확인한 id를 쓴다).
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    // chapter:chapters(…) 는 messages.chapter_id 외래 키를 따라 장 정보를 한 번에 묶어 오는 Supabase(PostgREST) 문법이다.
    // 별도 조회 없이 "7장 호봉획정 및 승급" 같은 표시용 정보를 함께 받는다.
    const { data, error } = await serviceSupabase()
      .from("messages")
      .select("id, question, answer, citations, created_at, chapter:chapters(id, title, chapter_number)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return Response.json({ messages: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
