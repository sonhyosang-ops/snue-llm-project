// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ask — 질문 처리: RAG의 "검색(Retrieval) → 생성(Generation)" 단계
//
// 처리 순서:
//   1) 로그인·허용 사용자 확인, 선택한 장이 운영 중인 판(문서)의 장인지 확인
//   1-2) [질문 보강] 같은 사용자의 최근 30분 안 질문·답변(messages)이 있으면, 그 흐름을 참고해 짧은 후속 질문
//        ("그럼 기간은?")을 완전한 한 문장으로 고쳐 쓴다(rewriteQuestion). 검색에는 원문과 고쳐 쓴 문장을 함께 쓴다.
//   2) [검색] 질문을 임베딩해 선택한 장의 청크 중 의미가 가장 가까운 2개를 찾고, 유사도가 낮은 것은 버린다
//        - 근거가 남으면 그대로 4)로 간다. 핵심어 사전과 맞든 안 맞든 선택한 장은 항상 먼저 검색한다.
//   3) [장 안내] 선택한 장에서 근거를 못 찾았을 때만 다른 장을 찾는다. 두 단계로 찾는다.
//        ① 운영 중인 문서 전체를 벡터 검색해 가장 가까운 청크가 있는 장(match_document_chunks)
//        ② ①도 없으면 다른 장의 핵심어 사전에서 질문 낱말과 맞는 장(문자열 비교)
//        찾은 장이 있으면 "다른 장을 확인해 볼까요?"를 제안(type: "suggestion")하고,
//        사용자가 동의해 approvedChapterId로 다시 들어오면 그 장을 검색한다. 어디에도 없으면 "찾지 못함"(type: "not_found")
//   4) [생성] 남은 근거를 정리(cleanChunk)해 답변을 만들고 질문 기록(messages)에 저장한다(type: "answer")
//        이 단계만 스트리밍이다. 응답은 NDJSON(한 줄에 JSON 하나)으로, 본문 조각(delta)이 먼저 흘러가고 마지막 줄에 AskResult가 온다.
//        1)~3)에서 끝나는 경우(오류, 장 안내, 찾지 못함)는 지금까지처럼 JSON 한 덩어리로 응답한다. 화면(page.tsx)이 Content-Type으로 구분한다.
//
// 2026-11-07 변경 전에는 핵심어 사전이 "문지기"였다. 질문 낱말이 선택한 장 사전과 문자열로 맞지 않으면
// 그 장의 본문은 검색하지 않고 바로 다른 장을 안내했다. 사용자가 사전과 다른 표현(띄어쓰기, 동의어)을 쓰면
// 답이 있어도 "찾지 못함"이 나왔다. 지금은 벡터 검색이 기본이고, 사전은 ②의 보조 신호로만 남겼다.
//
// 응답은 세 가지 중 하나다(src/lib/types.ts의 AskResult): answer / suggestion / not_found
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { groupByCitation } from "@/lib/answer-format";
import { cleanChunk, questionKeywords } from "@/lib/text";
import { serviceSupabase } from "@/lib/supabase";
import { answerWithSources, embed, rewriteQuestion } from "@/lib/upstage";
import type { AskResult, ChapterRef, Citation } from "@/lib/types";

type Supabase = ReturnType<typeof serviceSupabase>;
type KeywordRow = { chapter_id: string; term: string; score: number };
// DB 함수 match_chapter_chunks가 돌려주는 검색 결과 한 행(청크 + 질문과의 유사도)
type SourceRow = { id: string; heading: string; content: string; page_from: number; page_to: number; similarity: number };
// DB 함수 match_document_chunks가 돌려주는 한 행(청크가 어느 장에 있는지 + 유사도). 본문은 없다.
type DocumentHit = { id: string; chapter_id: string; similarity: number };

// 핵심어 사전에서 질문과 관련된 낱말을 찾는다. 다음 중 하나라도 맞으면 "관련 있음"이다.
//   ① 사전 낱말이 질문 문장 안에 그대로 들어 있다.        예) 질문 "육아휴직 기간은?" ↔ 사전 "육아휴직"
//   ② 질문 핵심어와 사전 낱말이 서로를 포함한다(부분 일치). 예) 핵심어 "휴직기간" ↔ 사전 "휴직"
// 사전에 "또는", "20" 같은 흔한 말이 섞여 있으면 거의 모든 질문이 걸리므로,
// 사전을 깨끗하게 유지하는 것(text.ts·upstage.ts의 핵심어 선정)이 이 판단의 정확도를 좌우한다.
function matchingRows(question: string, keywords: string[], rows: KeywordRow[]) {
  const normalizedQuestion = question.toLowerCase();
  return rows.filter((row) => normalizedQuestion.includes(row.term) || keywords.some((keyword) => row.term.includes(keyword) || keyword.includes(row.term)));
}

// 장 정보와 그 장이 속한 매뉴얼 이름, 운영 중 여부를 함께 불러온다.
// chapters → documents → manuals 외래 키를 따라 한 번에 묶어 오는 Supabase(PostgREST) 문법을 쓴다.
async function loadChapterRef(supabase: Supabase, chapterId: string) {
  const { data, error } = await supabase.from("chapters")
    .select("id, title, chapter_number, document:documents(is_active, status, manual:manuals(title))")
    .eq("id", chapterId).single();
  if (error) throw error;
  const document = data.document as unknown as { is_active: boolean; status: string; manual: { title: string } | null } | null;
  const chapter: ChapterRef = { id: data.id, title: data.title, chapter_number: data.chapter_number, manualTitle: document?.manual?.title ?? "" };
  return { chapter, active: Boolean(document?.is_active && document.status === "ready") };
}

// 운영 중인 판(매뉴얼마다 하나, is_active이고 처리가 끝난 문서)의 id 목록.
// 장 안내는 이 문서들의 장만 대상으로 한다(예전 판의 장을 안내하면 안 된다).
async function loadActiveDocumentIds(supabase: Supabase) {
  const { data, error } = await supabase.from("documents").select("id").eq("is_active", true).eq("status", "ready");
  if (error) throw error;
  return (data ?? []).map((document) => document.id);
}

// 운영 중인 문서들의 장 핵심어 사전을 불러온다.
// 사전은 매뉴얼 하나만으로도 1,000행이 넘을 수 있다. Supabase(PostgREST)는 요청 한 번에 최대 1,000행까지만 돌려주고
// 넘는 행은 오류 없이 빠지므로, 1,000행씩 나눠(range) 끝까지 읽는다(정렬 기준 id는 행마다 하나라 경계에서 겹치거나 빠지지 않는다).
async function loadActiveKeywordRows(supabase: Supabase, documentIds: string[]) {
  const { data: chapters, error: chaptersError } = await supabase.from("chapters").select("id").in("document_id", documentIds);
  if (chaptersError) throw chaptersError;
  const rows: KeywordRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("chapter_keywords").select("chapter_id, term, score")
      .in("chapter_id", (chapters ?? []).map((chapter) => chapter.id)).order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// 같은 사용자의 최근 질문·답변을 오래된 것부터 최대 3개 불러온다(질문 보강의 맥락으로 쓴다).
// 30분이 지난 기록은 "지금 대화"가 아니라고 보고 제외한다. 답변이 저장된 것만 있으므로 안내·찾지 못함은 맥락에 들어가지 않는다.
async function loadRecentTurns(supabase: Supabase, userId: string) {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("messages").select("question, answer")
    .eq("user_id", userId).gte("created_at", since).order("created_at", { ascending: false }).limit(3);
  if (error) throw error;
  return (data ?? []).reverse();
}

// 한 장 안에서 근거 청크를 찾는다.
// DB 함수 match_chapter_chunks(supabase/schema.sql)가 대상 장의 청크 중 질문 벡터와
// 코사인 거리가 가장 가까운 청크를 유사도(1 - 거리, 1에 가까울수록 비슷함)와 함께 돌려준다.
// 상위 2개만 쓴다. 근거 하나가 약 1,200자라 근거 수가 곧 답변 생성에 보내는 토큰 양을 좌우한다.
// 근거를 줄이면 비용과 응답 시간이 줄고, 관련이 덜한 근거가 답변에 섞이는 일도 줄어든다.
// 유사도가 기준점(floor)보다 낮은 청크는 버린다. 관련 없는 근거로 억지 답변을 만드는 것보다
// "찾지 못했다"고 답하는 편이 안전하기 때문이다.
// 남은 근거는 cleanChunk로 잡음(수식 기호, 영어 그림 설명, 쪽 번호)을 빼고 뭉개진 표를 펼친다.
// 같은 정리본을 답변 생성과 화면 표시에 함께 쓰므로, 모델이 본 근거와 사용자가 보는 근거가 같다.
async function searchChapter(supabase: Supabase, queryVector: number[], chapterId: string, floor: number) {
  const { data, error } = await supabase.rpc("match_chapter_chunks", { query_embedding: queryVector, target_chapter: chapterId, match_count: 2 });
  if (error) throw error;
  return ((data ?? []) as SourceRow[])
    .filter((source) => source.similarity >= floor)
    .map((source) => ({ ...source, content: cleanChunk(source.content) }));
}

// 선택한 장에서 근거를 못 찾았을 때, 질문과 가장 어울리는 "다른 장"의 id를 찾는다. 없으면 undefined.
//   ① 벡터: 운영 중인 문서 전체에서 가장 가까운 청크 5개를 보고, 기준점을 넘기면서 선택한 장이 아닌 첫 청크의 장
//      (선택한 장의 청크는 이미 기준점 아래라는 것을 알고 있으므로 건너뛴다)
//   ② 사전: ①이 없을 때, 다른 장 사전에서 질문 낱말과 맞는 것 중 점수(TF-IDF)가 가장 높은 낱말의 장
//      참고: TF-IDF는 매뉴얼(문서)마다 따로 계산되므로 매뉴얼 사이의 점수 비교는 대략적인 기준이다.
//      사전은 "육아휴직"처럼 정확한 용어가 있을 때 벡터가 놓친 장을 잡아 주는 보조 신호다.
async function findOtherChapter(supabase: Supabase, queryVector: number[], question: string, keywords: string[], selectedId: string, documentIds: string[], floor: number) {
  const { data: hits, error } = await supabase.rpc("match_document_chunks", { query_embedding: queryVector, target_documents: documentIds, match_count: 5 });
  if (error) throw error;
  const hit = ((hits ?? []) as DocumentHit[]).find((row) => row.similarity >= floor && row.chapter_id !== selectedId);
  if (hit) return hit.chapter_id;
  const rows = await loadActiveKeywordRows(supabase, documentIds);
  const alternative = matchingRows(question, keywords, rows.filter((row) => row.chapter_id !== selectedId)).sort((a, b) => b.score - a.score)[0];
  return alternative?.chapter_id;
}

// 답변 생성 단계의 스트리밍 응답. 줄마다 JSON 하나(NDJSON)를 보낸다.
//   {"type":"delta","text":"…"}    : 모델이 만든 본문 조각. 화면이 받는 대로 이어 붙여 그린다.
//   {"type":"result","result":…}   : 마지막 줄. 지금까지와 같은 AskResult(answer 또는 not_found)
//   {"type":"error","error":"…"}   : 생성 도중 실패. 헤더를 이미 보낸 뒤라 HTTP 상태 코드를 바꿀 수 없어 오류도 줄로 보낸다.
function ndjsonStream(run: (send: (event: object) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await run(send);
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "답변을 만들지 못했습니다." });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" } });
}

export async function POST(request: Request) {
  try {
    // [1] 허용된 사용자만 질문할 수 있다(src/lib/auth.ts).
    const user = await requireUser(request);
    // approvedChapterId: 사용자가 "해당 장에서 답변받기"를 눌러 다른 장 안내를 받아들였을 때 그 장의 id
    const { chapterId, question, approvedChapterId } = await request.json() as { chapterId?: string; question?: string; approvedChapterId?: string };
    if (!chapterId || !question?.trim()) throw new Error("장과 질문을 입력하세요.");
    const supabase = serviceSupabase();
    // 예전 판(운영 중이 아닌 문서)의 장 id로 질문하는 것을 막는다. 검색은 항상 운영 중인 판 안에서만 한다.
    const { chapter: selected, active } = await loadChapterRef(supabase, chapterId);
    if (!active) throw new Error("현재 운영 중인 매뉴얼의 장만 검색할 수 있습니다.");
    // 질문 핵심어는 화면에 "이 낱말로 찾았습니다"를 보여 주는 용도와, 사전으로 다른 장을 찾는 ②에 쓴다.
    const keywords = questionKeywords(question);
    // 유사도 기준점(RETRIEVAL_SCORE_FLOOR, 기본 0.35). 선택한 장 검색과 다른 장 안내에 같은 기준을 쓴다.
    const floor = Number(process.env.RETRIEVAL_SCORE_FLOOR ?? 0.35);

    // [1-2] 질문 보강: 최근 대화가 있으면 생략된 주어·대명사를 채운 문장으로 고쳐 쓴다. 대화가 없으면 원문 그대로다.
    // 검색 문장은 원문 + 고쳐 쓴 문장이다(교재 9장 방식). 고쳐 쓰기가 잘됐으면 그 문장이 검색을 이끌고,
    // 이상하게 됐어도 원문이 함께 있어 완전히 빗나가지는 않는 안전장치다.
    // 최근 문답은 질문 보강과 답변 생성(멀티턴 맥락) 두 곳에 쓴다.
    const turns = await loadRecentTurns(supabase, user.id);
    const rewritten = await rewriteQuestion(question, turns);
    const searchText = rewritten === question ? question : `${question}\n${rewritten}`;

    // [2] 검색: 질문 문장 전체를 query 모델로 임베딩한다(핵심어만 쓰면 질문의 맥락이 사라진다).
    // 임베딩은 한 번만 만들고, 선택한 장 검색·다른 장 안내·안내받은 장 검색에 같은 벡터를 다시 쓴다.
    const [queryVector] = await embed([searchText], process.env.UPSTAGE_QUERY_MODEL ?? "embedding-query");
    // target: 실제로 답변 근거를 가져온 장. 기본은 사용자가 선택한 장이다.
    let target = selected;
    let usableSources = await searchChapter(supabase, queryVector, selected.id, floor);

    // [3] 장 안내: 선택한 장에 쓸 만한 근거가 없을 때만 다른 장을 찾는다.
    if (!usableSources.length) {
      const documentIds = await loadActiveDocumentIds(supabase);
      const otherChapterId = await findOtherChapter(supabase, queryVector, question, keywords, selected.id, documentIds, floor);
      if (!otherChapterId) {
        const result: AskResult = { type: "not_found", keywords, message: "선택한 장과 다른 장에서 답변할 만큼 가까운 근거를 찾지 못했습니다." };
        return Response.json(result);
      }
      const { chapter: suggestion } = await loadChapterRef(supabase, otherChapterId);
      // 사용자가 아직 동의하지 않았으면 바로 검색하지 않고 장 이동을 제안만 한다.
      // 사용자가 "해당 장에서 답변받기"를 누르면 같은 질문이 approvedChapterId와 함께 다시 들어온다.
      if (approvedChapterId !== suggestion.id) {
        const result: AskResult = { type: "suggestion", keywords, chapter: suggestion };
        return Response.json(result);
      }
      target = suggestion;
      usableSources = await searchChapter(supabase, queryVector, suggestion.id, floor);
      if (!usableSources.length) {
        // 사전(②)으로 안내한 장은 낱말은 있어도 벡터 유사도가 기준점을 못 넘길 수 있다.
        const result: AskResult = { type: "not_found", keywords, message: "안내한 장에서도 답변할 만큼 가까운 근거를 찾지 못했습니다." };
        return Response.json(result);
      }
    }

    // [4] 생성: 남은 근거만으로 답변을 만든다. 근거 순서가 곧 답변 속 [1], [2] 번호다.
    // 여기부터는 스트리밍 응답이다. 모델이 본문을 쓰는 대로 delta 줄을 흘려보내고, 마지막에 result 줄을 보낸다.
    // (let으로 선언된 target·usableSources는 아래 콜백 안에서 바뀌지 않는다는 것을 타입 검사기가 모르므로 const에 옮겨 담는다.)
    const sourcesForAnswer = usableSources;
    const answerTarget = target;
    return ndjsonStream(async (send) => {
      // 모델에는 고쳐 쓴 질문을 보낸다("그럼 기간은?"보다 "육아휴직 기간은?"이 근거와 맞춰 답하기 쉽다). 기록에는 원문을 남긴다.
      // 결과는 JSON으로 받는다(StructuredAnswer): 본문, 인용 번호 목록, 근거 충분 여부.
      // 최근 문답(turns)을 함께 보내 "그건 왜?" 같은 후속 질문에도 답할 수 있게 한다(멀티턴). 번호는 이번 근거만 쓰도록 규칙이 막는다.
      const generated = await answerWithSources(rewritten, sourcesForAnswer, answerTarget.manualTitle, { history: turns, onAnswerDelta: (text) => send({ type: "delta", text }) });
      // 없는 근거 번호 제거: 근거가 2개인데 [3]을 쓰면 화면에서 눌러도 보여 줄 근거가 없다. 번호 표시만 지우고 문장은 남긴다.
      // 그 뒤 같은 근거의 문장을 한 문단으로 묶고 번호를 문단 끝에 한 번만 둔다(answer-format.ts). 모델이 이미 그렇게 썼으면 바뀌는 것이 없다.
      const answer = groupByCitation(generated.answer.replace(/\s*\[(\d+)\]/g, (mark, n) => (Number(n) >= 1 && Number(n) <= sourcesForAnswer.length ? mark : "")));
      if (!generated.enoughEvidence) {
        // 모델이 "제공된 근거로는 핵심을 확인할 수 없다"고 판단한 경우. 억지 답변 대신 "확인할 수 없습니다" 칸에
        // 모델의 설명을 보여 준다(무엇을 확인할 수 없었는지 사용자가 알 수 있게). 번호 표시는 빼고, 기록에는 남기지 않는다.
        const result: AskResult = { type: "not_found", keywords, message: answer.replace(/\s*\[\d+\]/g, "") };
        send({ type: "result", result });
        return;
      }
      // 화면 하단 "확인한 근거" 목록. 같은 순서로 만들어 답변의 [번호]와 맞춘다.
      // 원문은 정리된 마크다운 전체를 보내고, 화면이 표는 표로·글머리표는 목록으로 그린다(page.tsx).
      const citations: Citation[] = sourcesForAnswer.map((source) => ({
        chunkId: source.id,
        heading: source.heading,
        pageFrom: source.page_from,
        pageTo: source.page_to,
        excerpt: source.content,
        score: source.similarity,
      }));
      // 질문·답변·근거를 기록해 둔다. 답변 품질 점검과 자주 묻는 질문 분석에 쓸 수 있다.
      await supabase.from("messages").insert({ user_id: user.id, chapter_id: answerTarget.id, question, answer, citations });
      // rewrittenQuestion은 원문과 다를 때만 넣는다. 화면이 "질문을 이렇게 이해했습니다"로 보여 준다.
      const result: AskResult = { type: "answer", answer, citations, keywords, ...(rewritten !== question ? { rewrittenQuestion: rewritten } : {}) };
      send({ type: "result", result });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
