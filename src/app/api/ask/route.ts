import { errorResponse, requireUser } from "@/lib/auth";
import { questionKeywords } from "@/lib/text";
import { serviceSupabase } from "@/lib/supabase";
import { answerWithSources, embed } from "@/lib/upstage";
import type { AskResult, Citation } from "@/lib/types";

type KeywordRow = { chapter_id: string; term: string; score: number };

function matchingRows(question: string, keywords: string[], rows: KeywordRow[]) {
  const normalizedQuestion = question.toLowerCase();
  return rows.filter((row) => normalizedQuestion.includes(row.term) || keywords.some((keyword) => row.term.includes(keyword) || keyword.includes(row.term)));
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const { chapterId, question, approvedChapterId } = await request.json() as { chapterId?: string; question?: string; approvedChapterId?: string };
    if (!chapterId || !question?.trim()) throw new Error("장과 질문을 입력하세요.");
    const supabase = serviceSupabase();
    const { data: selected, error: selectedError } = await supabase
      .from("chapters")
      .select("id, title, chapter_number, document_id")
      .eq("id", chapterId)
      .single();
    if (selectedError) throw selectedError;

    const { data: activeDocument, error: activeError } = await supabase
      .from("documents")
      .select("id")
      .eq("id", selected.document_id)
      .eq("is_active", true)
      .eq("status", "ready")
      .maybeSingle();
    if (activeError) throw activeError;
    if (!activeDocument) throw new Error("현재 활성화된 문서의 장만 검색할 수 있습니다.");

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

    let target = selected;
    if (!selectedMatches.length) {
      const alternative = matchingRows(question, keywords, rows.filter((row) => row.chapter_id !== selected.id))
        .sort((a, b) => b.score - a.score)[0];
      if (alternative) {
        const { data: suggestion, error: suggestionError } = await supabase
          .from("chapters")
          .select("id, title, chapter_number, document_id")
          .eq("id", alternative.chapter_id)
          .single();
        if (suggestionError) throw suggestionError;
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

    const [queryVector] = await embed([question], process.env.UPSTAGE_QUERY_MODEL ?? "embedding-query");
    const { data: sources, error: searchError } = await supabase.rpc("match_chapter_chunks", {
      query_embedding: queryVector,
      target_chapter: target.id,
      match_count: 5,
    });
    if (searchError) throw searchError;
    const usableSources = (sources ?? []).filter((source: { similarity: number }) => source.similarity >= Number(process.env.RETRIEVAL_SCORE_FLOOR ?? 0.35));
    if (!usableSources.length) {
      const result: AskResult = { type: "not_found", keywords, message: "선택한 장에서 답변할 만큼 가까운 근거를 찾지 못했습니다." };
      return Response.json(result);
    }

    const answer = await answerWithSources(question, usableSources);
    const citations: Citation[] = usableSources.map((source: { id: string; heading: string; content: string; page_from: number; page_to: number; similarity: number }) => ({
      chunkId: source.id,
      heading: source.heading,
      pageFrom: source.page_from,
      pageTo: source.page_to,
      excerpt: source.content.replace(/\s+/g, " ").trim().slice(0, 240),
      score: source.similarity,
    }));
    await supabase.from("messages").insert({ user_id: user.id, chapter_id: target.id, question, answer, citations });
    const result: AskResult = { type: "answer", answer, citations, keywords };
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
