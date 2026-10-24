// ─────────────────────────────────────────────────────────────────────────────
// rebuild-keywords.mts — 활성 문서의 장별 핵심어 사전(chapter_keywords)을 다시 만드는 스크립트
//
// 언제 쓰나: 핵심어 뽑는 규칙(text.ts, upstage.ts의 selectTopicTerms)을 고친 뒤, PDF를 다시 올리지 않고
//           이미 DB에 있는 청크만으로 사전을 새로 만들 때. PDF 파싱·임베딩을 다시 하지 않아 비용이 거의 들지 않는다
//           (Chat 모델 호출만 장마다 5번 정도).
//
// 사용법(프로젝트 폴더에서 실행, .env.local의 키를 사용) — 두 단계로 나뉜다.
//   1단계 미리보기: npx tsx scripts/rebuild-keywords.mts <preview.json>
//                   → 새 사전을 만들어 preview.json에 저장만 한다. DB는 건드리지 않는다.
//   2단계 교체:     npx tsx scripts/rebuild-keywords.mts --apply <preview.json> <backup.json>
//                   → 1단계에서 확인한 preview.json을 "그대로" 저장한다. 기존 사전은 backup.json에 먼저 백업한다.
// 교체 때 사전을 다시 만들지 않는 이유: 모델의 판단은 실행할 때마다 조금씩 달라질 수 있어,
// 다시 만들면 사람이 확인한 목록과 실제로 저장되는 목록이 달라지기 때문이다.
//
// 확장자가 .mts인 이유: 이 프로젝트는 CommonJS 설정이라 .ts 파일에서는 최상위 await를 쓸 수 없다.
// .mts는 ES 모듈로 실행되므로 함수로 감싸지 않고 위에서 아래로 순서대로 읽히는 스크립트로 쓸 수 있다.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { serviceSupabase } from "@/lib/supabase";
import { chapterKeywordCandidates } from "@/lib/text";
import { selectTopicTerms } from "@/lib/upstage";

// Next.js 밖에서 실행되므로 .env.local을 직접 읽어 환경 변수로 등록한다(Node 21 이상 기능).
process.loadEnvFile(".env.local");
const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const [previewPath, backupPath] = apply ? args.slice(1) : args;
if (!previewPath || (apply && !backupPath)) throw new Error("사용법은 파일 맨 위 주석을 확인하세요.");

const supabase = serviceSupabase();
// 1) 활성 문서와 그 장 목록(목차 순서)을 불러온다.
const { data: document, error: documentError } = await supabase
  .from("documents").select("id, title").eq("is_active", true).eq("status", "ready").single();
if (documentError) throw documentError;
const { data: chapters, error: chaptersError } = await supabase
  .from("chapters").select("id, chapter_number, title").eq("document_id", document.id).order("display_order");
if (chaptersError) throw chaptersError;

type Keyword = { term: string; frequency: number; score: number };
type Result = { chapter: { id: string; chapter_number: string; title: string }; keywords: Keyword[] };

if (!apply) {
  // ── 1단계: 미리보기 만들기 ──
  // 2) 문서의 청크를 모두 불러온다.
  //    Supabase(PostgREST)는 요청 한 번에 최대 1,000행까지만 돌려주므로 1,000행씩 나눠(range) 끝까지 읽는다.
  const chunks: { chapter_id: string; ord: number; content: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("chunks").select("chapter_id, ord, content").eq("document_id", document.id).order("ord").range(from, from + 999);
    if (error) throw error;
    chunks.push(...data);
    if (data.length < 1000) break;
  }
  // 장 순서대로 청크 본문을 묶는다. 색인 때(ingest/route.ts)와 같은 입력 모양을 만들어 같은 결과가 나오게 한다.
  const allChapterTexts = chapters.map((chapter) => chunks.filter((chunk) => chunk.chapter_id === chapter.id).map((chunk) => chunk.content));

  // 3) 장마다 새 사전을 만든다: TF-IDF 후보 300개 → 모델이 장 주제에 속하는 명사만 고름.
  //    색인(ingest/route.ts)과 똑같은 함수를 써서, 문서를 새로 올렸을 때와 같은 방식으로 만들어진다.
  const results: Result[] = [];
  for (const [index, chapter] of chapters.entries()) {
    const candidates = chapterKeywordCandidates(allChapterTexts[index], allChapterTexts);
    const otherTitles = chapters.filter((other) => other.id !== chapter.id).map((other) => other.title);
    const picked = new Set(await selectTopicTerms(chapter.title, otherTitles, candidates.map((candidate) => candidate.term)));
    const keywords = candidates.filter((candidate) => picked.has(candidate.term));
    console.log(`${chapter.chapter_number}장 ${chapter.title}: 후보 ${candidates.length} → ${keywords.length}`);
    results.push({ chapter, keywords });
  }
  // 미리보기 파일: 사람이 장별 목록을 눈으로 확인하고 교체 여부를 정할 수 있게 저장한다.
  writeFileSync(previewPath, JSON.stringify(results, null, 2));
} else {
  // ── 2단계: 확인한 미리보기를 그대로 저장하기 ──
  const results = JSON.parse(readFileSync(previewPath, "utf8")) as Result[];
  // 미리보기가 지금 활성 문서의 장으로 만들어졌는지 확인한다(그사이 문서가 바뀌었으면 저장하지 않는다).
  const activeIds = new Set(chapters.map((chapter) => chapter.id));
  if (results.length !== chapters.length || results.some((result) => !activeIds.has(result.chapter.id))) throw new Error("미리보기가 현재 활성 문서의 장과 맞지 않아 교체하지 않았습니다.");
  // 핵심어가 하나도 없는 장이 있으면 그 장은 질문 안내가 전혀 되지 않으므로 교체하지 않는다.
  if (results.some((result) => !result.keywords.length)) throw new Error("핵심어가 비어 있는 장이 있어 교체하지 않았습니다.");
  // 4) 기존 사전을 먼저 백업한다. 청크와 마찬가지로 1,000행씩 나눠 읽어야 백업이 잘리지 않는다.
  const current: { chapter_id: string; term: string; frequency: number; score: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("chapter_keywords").select("chapter_id, term, frequency, score").in("chapter_id", chapters.map((chapter) => chapter.id)).order("id").range(from, from + 999);
    if (error) throw error;
    current.push(...data);
    if (data.length < 1000) break;
  }
  writeFileSync(backupPath, JSON.stringify(current, null, 2));
  // 5) 장마다 기존 사전을 지우고 새 사전을 넣는다.
  for (const { chapter, keywords } of results) {
    const { error: deleteError } = await supabase.from("chapter_keywords").delete().eq("chapter_id", chapter.id);
    if (deleteError) throw deleteError;
    const { error: insertError } = await supabase.from("chapter_keywords").insert(keywords.map((keyword) => ({ ...keyword, chapter_id: chapter.id })));
    if (insertError) throw insertError;
  }
  console.log(`교체 완료. 이전 사전 ${current.length}개는 ${backupPath}에 백업했습니다.`);
}
