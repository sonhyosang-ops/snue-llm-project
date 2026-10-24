// ─────────────────────────────────────────────────────────────────────────────
// keywords.ts — 장별 핵심어 사전 만들기(색인 API와 재생성 스크립트가 함께 쓰는 한 가지 방법)
//
//   ① chapterKeywordCandidates(text.ts) : 본문에서 TF-IDF 후보 300개
//   ② selectTopicTerms(upstage.ts)       : 모델이 장 주제에 속하는 명사만 고름(후보 밖 낱말은 들어올 수 없음)
//   ③ applyKeywordCorrections            : 사람이 검토한 제외·수정 목록 적용(keyword-corrections.ts)
// 색인(src/app/api/admin/documents/[id]/ingest)과 scripts/rebuild-keywords.mts가 같은 함수를 써서,
// 어느 쪽으로 만들어도 같은 규칙의 사전이 나온다.
// ─────────────────────────────────────────────────────────────────────────────
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyKeywordCorrections } from "@/lib/keyword-corrections";
import { chapterKeywordCandidates } from "@/lib/text";
import { selectTopicTerms } from "@/lib/upstage";

// 한 장의 핵심어 사전을 만든다.
//   - chapterTexts    : 대상 장의 청크 본문들
//   - allChapterTexts : 문서 전체의 장별 청크 본문들(IDF 계산용, 대상 장 포함)
export async function buildChapterKeywords(chapterTitle: string, otherTitles: string[], chapterTexts: string[], allChapterTexts: string[][]) {
  const candidates = chapterKeywordCandidates(chapterTexts, allChapterTexts);
  const picked = new Set(await selectTopicTerms(chapterTitle, otherTitles, candidates.map((candidate) => candidate.term)));
  return applyKeywordCorrections(candidates.filter((candidate) => picked.has(candidate.term)));
}

// 문서의 청크 본문을 장 순서대로 묶어 불러온다(핵심어 IDF 계산에는 문서 전체가 필요하다).
// Supabase(PostgREST)는 요청 한 번에 최대 1,000행까지만 돌려주므로 1,000행씩 나눠(range) 끝까지 읽는다.
// 나눠 읽을 때는 정렬이 행마다 하나로 정해져야 한다. ord는 장마다 0부터 다시 시작해 여러 장에 같은 값이 있으므로,
// (장, 순서)로 함께 정렬해야 페이지 경계에서 행이 겹치거나 빠지지 않는다.
export async function loadChapterTexts(supabase: SupabaseClient, documentId: string, chapterIds: string[]) {
  const chunks: { chapter_id: string; content: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("chunks").select("chapter_id, content").eq("document_id", documentId).order("chapter_id").order("ord").range(from, from + 999);
    if (error) throw error;
    chunks.push(...data);
    if (data.length < 1000) break;
  }
  return chapterIds.map((chapterId) => chunks.filter((chunk) => chunk.chapter_id === chapterId).map((chunk) => chunk.content));
}
