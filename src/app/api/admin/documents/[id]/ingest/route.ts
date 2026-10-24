// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/documents/[id]/ingest — 문서 색인(Indexing): RAG의 "준비" 단계 전체
//
// 관리자가 올린 PDF를 검색할 수 있는 형태로 바꿔 DB에 저장한다. 처리 순서:
//   1) Storage에서 PDF 내려받기
//   2) 앞 100쪽 파싱 → 목차에서 최상위 장 찾기 (detectChapterHeadings)
//   3) 장별로 나머지 쪽 파싱 → 청크로 자르기 (chunkPages)
//   4) 장 저장 → 장마다 청크 저장 → 청크 임베딩 저장 → 장별 핵심어 사전 저장
//   5) 이 문서를 "활성 문서"로 바꾸고 다른 문서는 비활성으로 돌린다
// 도중에 하나라도 실패하면 문서 상태를 failed로 바꾸고 오류 메시지를 남긴다(catch 블록).
// ─────────────────────────────────────────────────────────────────────────────
import { PDFDocument } from "pdf-lib";
import { errorResponse, requireAdmin } from "@/lib/auth";
import { chapterKeywordCandidates, chunkPages } from "@/lib/text";
import { serviceSupabase } from "@/lib/supabase";
import { detectChapterHeadings, embed, parsePdf, selectTopicTerms } from "@/lib/upstage";

// Vercel 서버 함수가 실행될 수 있는 최대 시간(초). 500쪽이 넘는 PDF를 파싱·임베딩하려면 기본값보다 길게 잡아야 한다.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
// Upstage Document Parse는 한 번에 100쪽까지만 받으므로 PDF를 100쪽 단위로 나누어 보낸다.
const PARSE_PAGE_LIMIT = 100;

// 장 시작 쪽 목록을 "장별 쪽 범위"로 바꾼다. 각 장은 다음 장 시작 바로 앞 쪽에서 끝나고, 마지막 장은 문서 끝까지다.
// 목차에서 장을 하나도 찾지 못하면 문서 전체를 "전체"라는 장 하나로 다룬다.
function rangesFromHeadings(headings: { title: string; chapterNumber: string; pageFrom: number }[], totalPages: number) {
  if (!headings.length) return [{ title: "전체", chapterNumber: "", pageFrom: 1, pageTo: totalPages }];
  return headings.map((heading, index) => ({ ...heading, pageTo: (headings[index + 1]?.pageFrom ?? totalPages + 1) - 1 }));
}

// 원본 PDF에서 pageFrom~pageTo 쪽만 복사해 새 PDF를 만들고 파싱한다.
// 마지막 인자(pageFrom - 1)는 잘라 낸 PDF의 1쪽을 원본 쪽 번호로 되돌리기 위한 보정값이다.
async function parseRange(source: PDFDocument, pageFrom: number, pageTo: number) {
  const part = await PDFDocument.create();
  const indexes = Array.from({ length: pageTo - pageFrom + 1 }, (_, index) => pageFrom - 1 + index);
  const copiedPages = await part.copyPages(source, indexes);
  copiedPages.forEach((page) => part.addPage(page));
  const bytes = await part.save();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return parsePdf(new Blob([copy.buffer], { type: "application/pdf" }), `pages-${pageFrom}-${pageTo}.pdf`, pageFrom - 1);
}

export async function POST(request: Request, { params }: Params) {
  try {
    // 색인은 비용이 드는 작업이므로 관리자만 실행할 수 있다.
    await requireAdmin(request);
    const { id } = await params;
    const supabase = serviceSupabase();
    const { data: document, error: documentError } = await supabase.from("documents").select("id, title, storage_path").eq("id", id).single();
    if (documentError) throw documentError;

    // [1] 처리 중 상태로 바꾸고, 업로드 때 Storage에 저장해 둔 PDF를 내려받는다.
    await supabase.from("documents").update({ status: "processing", error: null }).eq("id", id);
    const { data: file, error: downloadError } = await supabase.storage.from("personnel-pdfs").download(document.storage_path);
    if (downloadError || !file) throw downloadError ?? new Error("PDF 파일을 읽지 못했습니다.");

    const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    const pageCount = source.getPageCount();
    // [2] 앞 100쪽을 먼저 파싱해 목차에서 장을 찾는다. 이 결과(tocPages)는 앞쪽 장의 본문으로도 다시 쓴다.
    const tocPages = await parseRange(source, 1, Math.min(PARSE_PAGE_LIMIT, pageCount));
    const headings = await detectChapterHeadings(tocPages, pageCount);
    const ranges = rangesFromHeadings(headings, pageCount);
    const drafts = [] as { title: string; chapterNumber: string; pageFrom: number; pageTo: number; pages: Awaited<ReturnType<typeof parsePdf>> }[];
    // [3] 장마다 본문 쪽을 모은다. 100쪽 이내는 이미 파싱한 tocPages에서 가져오고,
    //     그 뒤 쪽은 100쪽 단위로 잘라 추가로 파싱한다(같은 쪽을 두 번 파싱하지 않아 비용을 아낀다).
    for (const range of ranges) {
      const chapterPages = tocPages.filter((page) => page.page >= range.pageFrom && page.page <= Math.min(range.pageTo, PARSE_PAGE_LIMIT));
      for (let pageFrom = Math.max(range.pageFrom, PARSE_PAGE_LIMIT + 1); pageFrom <= range.pageTo; pageFrom += PARSE_PAGE_LIMIT) {
        chapterPages.push(...await parseRange(source, pageFrom, Math.min(pageFrom + PARSE_PAGE_LIMIT - 1, range.pageTo)));
      }
      drafts.push({ ...range, pages: chapterPages });
    }
    // 장별 본문을 청크로 자른다. 청크가 하나도 없는 장(빈 장)은 저장하지 않는다.
    const prepared = drafts.map((draft) => ({ ...draft, chunks: chunkPages(draft.pages) })).filter((draft) => draft.chunks.length);
    if (!prepared.length) throw new Error("저장할 청크를 만들지 못했습니다.");

    // [4] 같은 문서를 다시 색인하는 경우를 위해 기존 장을 먼저 지운다.
    //     장을 지우면 연결된 청크·임베딩·핵심어도 DB의 cascade 설정에 따라 함께 지워진다(supabase/schema.sql).
    await supabase.from("chapters").delete().eq("document_id", id);
    const { data: chapters, error: chapterError } = await supabase
      .from("chapters")
      .insert(prepared.map((draft, display_order) => ({
        document_id: id,
        chapter_number: draft.chapterNumber,
        title: draft.title,
        page_from: draft.pageFrom,
        page_to: draft.pageTo,
        display_order,
      })))
      .select("id, display_order, title");
    if (chapterError || !chapters) throw chapterError ?? new Error("장을 저장하지 못했습니다.");

    // 핵심어 점수(IDF)는 "다른 장과 비교"해야 계산할 수 있으므로 전체 장의 청크 본문을 미리 모아 둔다.
    const allChapterTexts = prepared.map((draft) => draft.chunks.map((chunk) => chunk.content));
    for (const chapter of chapters) {
      const draft = prepared.find((item, index) => index === chapter.display_order);
      if (!draft) continue;
      // 청크 저장. heading(꼭지 제목)에는 장 제목을 넣어 화면의 "확인한 근거"에 표시한다.
      // ord는 장 안에서의 청크 순서다. 저장된 id는 바로 아래 임베딩과 짝을 맞추는 데 쓴다.
      const { data: insertedChunks, error: chunkError } = await supabase
        .from("chunks")
        .insert(draft.chunks.map((chunk, ord) => ({
          document_id: id,
          chapter_id: chapter.id,
          ord,
          heading: chapter.title,
          page_from: chunk.pageFrom,
          page_to: chunk.pageTo,
          content: chunk.content,
        })))
        .select("id, content");
      if (chunkError || !insertedChunks) throw chunkError ?? new Error("청크를 저장하지 못했습니다.");

      // 청크 본문을 passage 모델로 임베딩해 저장한다. 어떤 모델로 만든 벡터인지 model 열에 함께 남긴다.
      const vectors = await embed(insertedChunks.map((chunk) => chunk.content), process.env.UPSTAGE_PASSAGE_MODEL ?? "embedding-passage");
      const { error: embeddingError } = await supabase.from("embeddings").insert(insertedChunks.map((chunk, index) => ({
        chunk_id: chunk.id,
        embedding: vectors[index],
        model: process.env.UPSTAGE_PASSAGE_MODEL ?? "embedding-passage",
      })));
      if (embeddingError) throw embeddingError;

      // 장별 핵심어 사전: ① TF-IDF로 본문에서 후보 300개를 뽑고 ② 모델이 장 주제에 속하는 명사만 고른다.
      // 모델은 후보 중에서 고르기만 하므로 본문에 없는 낱말은 사전에 들어가지 않는다.
      const candidates = chapterKeywordCandidates(draft.chunks.map((chunk) => chunk.content), allChapterTexts);
      const otherTitles = chapters.filter((other) => other.id !== chapter.id).map((other) => other.title);
      const picked = new Set(await selectTopicTerms(chapter.title, otherTitles, candidates.map((candidate) => candidate.term)));
      if (!picked.size) throw new Error(`'${chapter.title}' 장의 핵심어를 고르지 못했습니다.`);
      const keywords = candidates.filter((candidate) => picked.has(candidate.term));
      const { error: keywordError } = await supabase.from("chapter_keywords").insert(keywords.map((keyword) => ({ ...keyword, chapter_id: chapter.id })));
      if (keywordError) throw keywordError;
    }

    // [5] 모든 장이 끝나면 이 문서를 활성 문서로 바꾼다. 사용자 화면은 활성 문서 하나만 보여 준다.
    await supabase.from("documents").update({ status: "ready", is_active: true, processed_at: new Date().toISOString() }).eq("id", id);
    await supabase.from("documents").update({ is_active: false }).neq("id", id);
    return Response.json({ ok: true, chapterCount: chapters.length, pageCount });
  } catch (error) {
    // 실패하면 문서 상태를 failed로 바꾸고 오류 메시지(최대 500자)를 남긴다. 관리자가 원인을 확인할 수 있다.
    // 주의: 실패 전에 저장된 장·청크는 남는다. 정리가 필요하면 failed 문서를 지우면 cascade로 함께 지워진다.
    try {
      const { id } = await params;
      await serviceSupabase().from("documents").update({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "처리 실패" }).eq("id", id);
    } catch { /* 상태 기록마저 실패해도 원래 오류를 돌려주는 편이 원인 파악에 더 유용하므로 여기서는 무시한다. */ }
    return errorResponse(error);
  }
}
