// ─────────────────────────────────────────────────────────────────────────────
// POST /api/quiz/answer — 채점(이해도 확인 1단계, 2026-11-08)
//
// 요청: { questionId, answer }  answer는 'O'·'X' 또는 '1'~'4'
// O/X·4지선다는 정답이 정해져 있으므로 모델 없이 서버에서 문자열 비교로 바로 채점한다(비용·지연 없음).
// 문제는 "내가 만든 문제"만 채점한다(user_id 확인). 다른 사람의 문제 id를 보내도 정답이 새지 않는다.
// 같은 문제를 다시 풀면 풀이 기록이 하나 더 쌓인다(틀린 문제를 다시 풀어 보는 용도).
// 응답: { correct, answer, explanation, citation, stats }  — 정답·해설·근거 원문은 채점 뒤에만 보낸다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { loadStats } from "@/lib/quiz";
import { serviceSupabase } from "@/lib/supabase";
import type { QuizAnswerResult } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const { questionId, answer } = await request.json() as { questionId?: string; answer?: string };
    if (!questionId || !answer) throw new Error("문제와 답을 보내세요.");
    const supabase = serviceSupabase();
    const { data: question, error } = await supabase.from("quiz_questions")
      .select("id, chapter_id, answer, explanation, citation").eq("id", questionId).eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!question) throw new Error("문제를 찾지 못했습니다.");
    const correct = answer.trim().toUpperCase() === question.answer;
    const { error: insertError } = await supabase.from("quiz_attempts").insert({ user_id: user.id, question_id: question.id, chapter_id: question.chapter_id, answer: answer.trim().toUpperCase(), correct });
    if (insertError) throw insertError;
    const result: QuizAnswerResult = {
      correct,
      answer: question.answer,
      explanation: question.explanation,
      citation: question.citation as QuizAnswerResult["citation"],
      stats: await loadStats(supabase, user.id, question.chapter_id),
    };
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
