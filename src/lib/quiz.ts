// ─────────────────────────────────────────────────────────────────────────────
// quiz.ts — 문제 풀기 API 두 곳(api/quiz, api/quiz/answer)이 함께 쓰는 조회
//
// Next.js의 route.ts 파일은 GET·POST 같은 HTTP 처리 함수만 내보낼 수 있어서(그 밖의 export는 빌드 오류),
// 두 라우트가 같이 쓰는 함수는 이렇게 lib 파일에 둔다.
// ─────────────────────────────────────────────────────────────────────────────
import type { serviceSupabase } from "@/lib/supabase";
import type { QuizStats } from "@/lib/types";

type Supabase = ReturnType<typeof serviceSupabase>;

// 장별 누적 성적: 이 장에서 내가 답한 문제 수와 맞힌 수.
// select의 count: "exact", head: true 는 행을 받지 않고 개수만 세는 Supabase(PostgREST) 옵션이다.
export async function loadStats(supabase: Supabase, userId: string, chapterId: string): Promise<QuizStats> {
  const base = () => supabase.from("quiz_attempts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("chapter_id", chapterId);
  const [{ count: total, error: totalError }, { count: correct, error: correctError }] = await Promise.all([base(), base().eq("correct", true)]);
  if (totalError) throw totalError;
  if (correctError) throw correctError;
  return { total: total ?? 0, correct: correct ?? 0 };
}
