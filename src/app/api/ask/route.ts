// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ask — 질문 처리: RAG의 "검색(Retrieval) → 생성(Generation)" 단계
//
// 처리 순서:
//   1) 로그인·허용 사용자 확인, 선택한 장이 활성 문서의 장인지 확인
//   2) [장 안내] 질문 핵심어가 선택한 장의 핵심어 사전에 있는지 확인
//        - 있으면 그 장에서 검색
//        - 없으면 다른 장 사전에서 찾아 "다른 장을 확인해 볼까요?"를 제안(type: "suggestion")
//        - 어느 장에도 없으면 "찾지 못함"(type: "not_found")
//   3) [검색] 질문을 임베딩해 그 장의 청크 중 의미가 가장 가까운 2개를 찾고, 유사도가 낮은 것은 버린다
//   4) [생성] 남은 근거를 정리(cleanChunk)해 답변을 만들고 질문 기록(messages)에 저장한다(type: "answer")
//
// 응답은 세 가지 중 하나다(src/lib/types.ts의 AskResult): answer / suggestion / not_found
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { cleanChunk, questionKeywords } from "@/lib/text";
import { serviceSupabase } from "@/lib/supabase";
import { answerWithSources, embed } from "@/lib/upstage";
import type { AskResult, Citation } from "@/lib/types";

type KeywordRow = { chapter_id: string; term: string; score: number };
// DB 함수 match_chapter_chunks가 돌려주는 검색 결과 한 행(청크 + 질문과의 유사도)
type SourceRow = { id: string; heading: string; content: string; page_from: number; page_to: number; similarity: number };

// 핵심어 사전에서 질문과 관련된 낱말을 찾는다. 다음 중 하나라도 맞으면 "관련 있음"이다.
//   ① 사전 낱말이 질문 문장 안에 그대로 들어 있다.        예) 질문 "육아휴직 기간은?" ↔ 사전 "육아휴직"
//   ② 질문 핵심어와 사전 낱말이 서로를 포함한다(부분 일치). 예) 핵심어 "휴직기간" ↔ 사전 "휴직"
// 사전에 "또는", "20" 같은 흔한 말이 섞여 있으면 거의 모든 질문이 걸리므로,
// 사전을 깨끗하게 유지하는 것(text.ts·upstage.ts의 핵심어 선정)이 이 판단의 정확도를 좌우한다.
function matchingRows(question: string, keywords: string[], rows: KeywordRow[]) {
  const normalizedQuestion = question.toLowerCase();
  return rows.filter((row) => normalizedQuestion.includes(row.term) || keywords.some((keyword) => row.term.includes(keyword) || keyword.includes(row.term)));
}

export async function POST(request: Request) {
  try {
    // [1] 허용된 사용자만 질문할 수 있다(src/lib/auth.ts).
    const user = await requireUser(request);
    // approvedChapterId: 사용자가 "해당 장에서 답변받기"를 눌러 다른 장 안내를 받아들였을 때 그 장의 id
    const { chapterId, question, approvedChapterId } = await request.json() as { chapterId?: string; question?: string; approvedChapterId?: string };
    if (!chapterId || !question?.trim()) throw new Error("장과 질문을 입력하세요.");
    const supabase = serviceSupabase();
    const { data: selected, error: selectedError } = await supabase
      .from("chapters")
      .select("id, title, chapter_number, document_id")
      .eq("id", chapterId)
      .single();
    if (selectedError) throw selectedError;

    // 예전 문서의 장 id로 질문하는 것을 막는다. 검색은 항상 현재 활성 문서 안에서만 한다.
    const { data: activeDocument, error: activeError } = await supabase
      .from("documents")
      .select("id")
      .eq("id", selected.document_id)
      .eq("is_active", true)
      .eq("status", "ready")
      .maybeSingle();
    if (activeError) throw activeError;
    if (!activeDocument) throw new Error("현재 활성화된 문서의 장만 검색할 수 있습니다.");

    // [2] 장 안내: 질문 핵심어를 뽑고, 같은 문서의 모든 장 핵심어 사전을 불러온다.
    const keywords = questionKeywords(question);
    const { data: documentChapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("id")
      .eq("document_id", selected.document_id);
    if (chaptersError) throw chaptersError;
    const { data: allKeywords, error: keywordError } = await supabase
      .from("chapter_keywords")
      .select("chapter_id, term, score")
      .in("chapter_id", (documentChapters ?? []).map((chapter) => chapter.id));
    if (keywordError) throw keywordError;
    const rows = (allKeywords ?? []) as KeywordRow[];
    const selectedMatches = matchingRows(question, keywords, rows.filter((row) => row.chapter_id === selected.id));

    // target: 실제로 검색할 장. 기본은 사용자가 선택한 장이다.
    let target = selected;
    if (!selectedMatches.length) {
      // 선택한 장 사전에 맞는 낱말이 없으면 다른 장 사전에서 찾고, 점수(TF-IDF)가 가장 높은 낱말의 장을 고른다.
      const alternative = matchingRows(question, keywords, rows.filter((row) => row.chapter_id !== selected.id))
        .sort((a, b) => b.score - a.score)[0];
      if (alternative) {
        const { data: suggestion, error: suggestionError } = await supabase
          .from("chapters")
          .select("id, title, chapter_number, document_id")
          .eq("id", alternative.chapter_id)
          .single();
        if (suggestionError) throw suggestionError;
        // 사용자가 아직 동의하지 않았으면 바로 검색하지 않고 장 이동을 제안만 한다.
        // 사용자가 "해당 장에서 답변받기"를 누르면 같은 질문이 approvedChapterId와 함께 다시 들어온다.
        if (approvedChapterId !== suggestion.id) {
          const result: AskResult = { type: "suggestion", keywords, chapter: suggestion };
          return Response.json(result);
        }
        target = suggestion;
      } else {
        const result: AskResult = { type: "not_found", keywords, message: "선택한 장과 다른 장의 핵심어 사전에서 관련 내용을 찾지 못했습니다." };
        return Response.json(result);
      }
    }

    // [3] 검색: 질문 문장 전체를 query 모델로 임베딩한다(핵심어만 쓰면 질문의 맥락이 사라진다).
    const [queryVector] = await embed([question], process.env.UPSTAGE_QUERY_MODEL ?? "embedding-query");
    // DB 함수 match_chapter_chunks(supabase/schema.sql)가 대상 장의 청크 중 질문 벡터와
    // 코사인 거리가 가장 가까운 청크를 유사도(1 - 거리, 1에 가까울수록 비슷함)와 함께 돌려준다.
    // 상위 2개만 쓴다. 근거 하나가 약 1,200자라 근거 수가 곧 답변 생성에 보내는 토큰 양을 좌우한다.
    // 근거를 줄이면 비용과 응답 시간이 줄고, 관련이 덜한 근거가 답변에 섞이는 일도 줄어든다.
    const { data: sources, error: searchError } = await supabase.rpc("match_chapter_chunks", {
      query_embedding: queryVector,
      target_chapter: target.id,
      match_count: 2,
    });
    if (searchError) throw searchError;
    // 유사도가 기준점(RETRIEVAL_SCORE_FLOOR, 기본 0.35)보다 낮은 청크는 버린다.
    // 관련 없는 근거로 억지 답변을 만드는 것보다 "찾지 못했다"고 답하는 편이 안전하기 때문이다.
    // 남은 근거는 cleanChunk로 잡음(수식 기호, 영어 그림 설명, 쪽 번호)을 빼고 뭉개진 표를 펼친다.
    // 같은 정리본을 답변 생성과 화면 표시에 함께 쓰므로, 모델이 본 근거와 사용자가 보는 근거가 같다.
    const usableSources = ((sources ?? []) as SourceRow[])
      .filter((source) => source.similarity >= Number(process.env.RETRIEVAL_SCORE_FLOOR ?? 0.35))
      .map((source) => ({ ...source, content: cleanChunk(source.content) }));
    if (!usableSources.length) {
      const result: AskResult = { type: "not_found", keywords, message: "선택한 장에서 답변할 만큼 가까운 근거를 찾지 못했습니다." };
      return Response.json(result);
    }

    // [4] 생성: 남은 근거만으로 답변을 만든다. 근거 순서가 곧 답변 속 [1], [2] 번호다.
    const answer = await answerWithSources(question, usableSources);
    // 화면 하단 "확인한 근거" 목록. 같은 순서로 만들어 답변의 [번호]와 맞춘다.
    // 원문은 정리된 마크다운 전체를 보내고, 화면이 표는 표로·글머리표는 목록으로 그린다(page.tsx).
    const citations: Citation[] = usableSources.map((source) => ({
      chunkId: source.id,
      heading: source.heading,
      pageFrom: source.page_from,
      pageTo: source.page_to,
      excerpt: source.content,
      score: source.similarity,
    }));
    // 질문·답변·근거를 기록해 둔다. 답변 품질 점검과 자주 묻는 질문 분석에 쓸 수 있다.
    await supabase.from("messages").insert({ user_id: user.id, chapter_id: target.id, question, answer, citations });
    const result: AskResult = { type: "answer", answer, citations, keywords };
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
