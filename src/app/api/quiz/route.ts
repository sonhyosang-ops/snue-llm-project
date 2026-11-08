// ─────────────────────────────────────────────────────────────────────────────
// POST /api/quiz — 문제 만들기(이해도 확인 1단계, 2026-11-08)
//
// 관리자(교감·교장) 시험을 준비하는 교사가 편람 내용을 얼마나 이해했는지 스스로 확인하는 기능이다.
// 요청: { chapterId, scope }  scope는 두 가지(src/lib/types.ts의 QuizScope)
//   - recent  : 이 장에서 내가 최근에 한 상담(질문·답변)의 "상황"을 소재로 출제. 상담에서 이미 물은 쟁점은 피하고
//               같은 상황의 다른 쟁점을 묻는다(예: "복직 서류" 상담 → 복직 시기·기간 산정·경력 인정 문제). 재료는 상담 질문으로
//               이 장을 다시 벡터 검색해 넓게 모은 원문이다(recentMaterial).
//   - chapter : 이 장 원문(chunks)에서 무작위로 골라 출제. 질문 기록이 없거나 장 전체를 훑고 싶을 때.
// 처리 순서:
//   1) 로그인·허용 사용자 확인, 운영 중인 판의 장인지 확인
//   2) 출제 재료(근거 원문) 모으기 — 장 전체는 4개, 최근 문답은 6개
//   3) 모델에 문제 5개를 JSON으로 요청(generateQuiz)
//   4) [근거 검증] 문제마다 모델이 옮겨 적은 근거 문장(evidence)이 실제 원문에 있는지 검사하고, 없으면 그 문제를 버린다.
//      답변에서 "없는 근거 번호를 지우는" 것과 같은 장치로, 편람에 없는 내용을 묻는 문제가 화면에 나가지 않게 한다.
//   5) 남은 문제를 quiz_questions에 저장하고, 화면에는 정답·해설을 뺀 문제만 보낸다(채점은 /api/quiz/answer).
// 응답: { questions: QuizQuestion[], stats: QuizStats }
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { loadStats } from "@/lib/quiz";
import { cleanChunk } from "@/lib/text";
import { serviceSupabase } from "@/lib/supabase";
import { describeConsultations, embed, generateQuiz, type Consultation, type Scenario } from "@/lib/upstage";
import type { Citation, QuizQuestion, QuizScope } from "@/lib/types";

// Vercel 서버 함수 최대 실행 시간(초). 모델이 문제 4개를 JSON으로 쓰는 데 30~50초가 걸린다(실측). 기본 제한을 넘기므로 늘린다.
export const maxDuration = 120;

type Supabase = ReturnType<typeof serviceSupabase>;
// 출제 재료 하나. 화면의 "답변 출처"와 같은 모양(점수만 없음)이라 채점 뒤 그대로 근거로 보여 줄 수 있다.
type Source = Omit<Citation, "score">;

// 한 번에 만드는 문제 수. 5개는 생성에 50초 넘게 걸려(실측) 4개로 줄였다. 문제 수가 출력 토큰 양, 곧 걸리는 시간을 좌우한다.
const QUESTION_COUNT = 4;
// 장 전체 출제에 쓰는 원문 수. 근거 하나가 약 1,200자다.
const SOURCE_COUNT = 3;
// 최근 문답 출제에 쓰는 원문 수. 상담 상황의 "다른 쟁점"을 찾으려면 조금 더 넓게 보여 줘야 한다.
const RECENT_SOURCE_COUNT = 4;

// DB 함수 match_chapter_chunks가 돌려주는 한 행(api/ask와 같다)
type SourceRow = { id: string; heading: string; content: string; page_from: number; page_to: number; similarity: number };

// "최근 문답" 출제 재료(2026-11-08 사용자 요청: 상담의 상황은 가져오되 쟁점은 바꿔 묻는다).
//   1) 이 장에서 내가 최근에 한 질문·답변(최대 3건)을 상담 내역으로 모은다. 답변의 [번호]는 뗀다.
//   2) 상담마다 "상황"과 "이미 물은 쟁점"을 모델이 뽑는다(describeConsultations).
//   3) 저장된 근거 2개는 "이미 물은 쟁점"의 원문이라 다른 쟁점을 내기에 부족하다. 그래서 상황 문장을 임베딩해
//      이 장에서 가까운 청크를 상담마다 4개씩 찾는다(상담 질문으로 찾으면 다시 그 쟁점의 원문만 모인다). 겹치면 한 번만 넣는다.
//   원문은 답변 때와 같은 cleanChunk 정리본이다.
async function recentMaterial(supabase: Supabase, userId: string, chapterId: string): Promise<{ scenarios: Scenario[]; sources: Source[] }> {
  const { data, error } = await supabase.from("messages").select("question, answer")
    .eq("user_id", userId).eq("chapter_id", chapterId).order("created_at", { ascending: false }).limit(3);
  if (error) throw error;
  const consultations: Consultation[] = (data ?? []).map((row) => ({ question: row.question, answer: row.answer.replace(/\s*\[\d+\]/g, "").slice(0, 600) }));
  if (!consultations.length) return { scenarios: [], sources: [] };
  const scenarios = await describeConsultations(consultations);
  const vectors = await embed(scenarios.map((item) => item.situation), process.env.UPSTAGE_QUERY_MODEL ?? "embedding-query");
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const vector of vectors) {
    const { data: rows, error: searchError } = await supabase.rpc("match_chapter_chunks", { query_embedding: vector, target_chapter: chapterId, match_count: 4 });
    if (searchError) throw searchError;
    for (const row of (rows ?? []) as SourceRow[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      sources.push({ chunkId: row.id, heading: row.heading, pageFrom: row.page_from, pageTo: row.page_to, excerpt: cleanChunk(row.content) });
    }
  }
  return { scenarios, sources: sources.slice(0, RECENT_SOURCE_COUNT) };
}

// 이 장의 청크 중 무작위로 고른다. 장 하나의 청크는 많아야 수백 개라 id·본문을 한 번에 읽어도 된다.
// 원문은 답변 때와 같은 cleanChunk 정리본을 쓴다(수식 기호·쪽 번호 같은 잡음이 문제에 섞이지 않게).
async function chapterSources(supabase: Supabase, chapterId: string): Promise<Source[]> {
  const { data, error } = await supabase.from("chunks").select("id, heading, content, page_from, page_to").eq("chapter_id", chapterId);
  if (error) throw error;
  const rows = [...(data ?? [])];
  // 피셔-예이츠 섞기: 앞에서부터 하나씩 "남은 것 중 무작위 하나"와 자리를 바꾼다. 모든 순서가 같은 확률로 나온다.
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, SOURCE_COUNT).map((row) => ({ chunkId: row.id, heading: row.heading, pageFrom: row.page_from, pageTo: row.page_to, excerpt: cleanChunk(row.content) }));
}

// 근거 검증용 정규화: 띄어쓰기·줄바꿈, 마크다운 기호(표의 |, 굵게 **), 하이픈·문장 부호를 모두 지워 글자와 숫자만 남긴다.
// 모델이 문장을 옮기며 띄어쓰기를 바꾸거나 표 칸 구분을 빼는 정도는 "같은 문장"으로 본다.
// 하이픈을 지우는 이유: 정리본에는 PDF 줄바꿈 자리의 "-"가 남아 있는데("기준으로-사전에") 모델은 이를 빼고 옮긴다(실측).
const squeeze = (text: string) => text.replace(/[\s|*#>`\-–—·ㆍ,.:;()（）[\]「」『』※○•]/g, "");

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const { chapterId, scope } = await request.json() as { chapterId?: string; scope?: QuizScope };
    if (!chapterId || (scope !== "recent" && scope !== "chapter")) throw new Error("장과 출제 범위를 선택하세요.");
    const supabase = serviceSupabase();
    // [1] 운영 중인 판의 장만. 매뉴얼 이름은 출제 지시문에 쓴다.
    const { data: chapter, error: chapterError } = await supabase.from("chapters")
      .select("id, document:documents(is_active, status, manual:manuals(title))").eq("id", chapterId).single();
    if (chapterError) throw chapterError;
    const document = chapter.document as unknown as { is_active: boolean; status: string; manual: { title: string } | null } | null;
    if (!document?.is_active || document.status !== "ready") throw new Error("현재 운영 중인 매뉴얼의 장에서만 문제를 만들 수 있습니다.");

    // [2] 출제 재료. 최근 문답은 상담에서 뽑은 상황(scenarios)과 그 상황으로 찾은 원문, 장 전체는 무작위 원문만.
    const { scenarios, sources } = scope === "recent"
      ? await recentMaterial(supabase, user.id, chapterId)
      : { scenarios: [] as Scenario[], sources: await chapterSources(supabase, chapterId) };
    if (!sources.length) throw new Error(scope === "recent" ? "이 장에서 한 질문 기록이 없습니다. '이 장 전체'로 만들어 보세요." : "이 장에는 아직 본문이 없습니다.");

    // [3] 모델에 문제 요청. 상황이 있으면 상황은 가져오고 이미 물은 쟁점은 피해 내도록 지시한다(generateQuiz).
    const generated = await generateQuiz(sources.map((source) => ({ heading: source.heading, content: source.excerpt })), document.manual?.title ?? "", QUESTION_COUNT, scenarios);

    // [4] 근거 검증: 옮겨 적은 문장이 원문에 없으면 그 문제는 버린다(너무 짧은 문장은 우연히 맞을 수 있어 8자 미만도 버린다).
    const verified = generated.filter((item) => {
      const evidence = squeeze(item.evidence);
      return evidence.length >= 8 && squeeze(sources[item.source - 1].excerpt).includes(evidence);
    });
    if (!verified.length) throw new Error("근거가 확인되는 문제를 만들지 못했습니다. 다시 시도해 주세요.");

    // [5] 저장. 정답·해설·근거는 서버만 갖고 있다가 채점 때 보낸다.
    const { data: rows, error: insertError } = await supabase.from("quiz_questions").insert(verified.map((item) => ({
      user_id: user.id, chapter_id: chapterId, source: scope, kind: item.kind, prompt: item.prompt, choices: item.choices,
      answer: item.answer, explanation: item.explanation, evidence: item.evidence, citation: sources[item.source - 1],
    }))).select("id, kind, prompt, choices");
    if (insertError) throw insertError;
    const questions: QuizQuestion[] = (rows ?? []).map((row) => ({ id: row.id, kind: row.kind, prompt: row.prompt, choices: row.choices as string[] }));
    return Response.json({ questions, stats: await loadStats(supabase, user.id, chapterId) });
  } catch (error) {
    return errorResponse(error);
  }
}
