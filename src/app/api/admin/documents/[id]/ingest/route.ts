// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/documents/[id]/ingest — 문서 색인(Indexing): RAG의 "준비" 단계 (관리자 전용)
//
// 관리자가 올린 PDF를 검색할 수 있는 형태로 바꿔 DB에 저장한다. 500쪽이 넘는 편람을 한 번의 요청으로 처리하면
// 서버 함수 시간 제한(maxDuration)을 넘길 수 있으므로, 단계를 나누어 관리자 화면이 차례로 호출한다.
//   body { step: "outline" }               : PDF 앞부분(목차) 파싱 → 최상위 장과 쪽 범위 저장
//   body { step: "chapter", chapterId }    : 그 장의 쪽만 파싱 → 청크 → 임베딩 저장
//   body { step: "keywords", chapterId }   : 그 장의 핵심어 사전 저장(문서 전체 청크가 있어야 IDF를 계산할 수 있어 본문 단계 뒤에 한다)
//   body { step: "finish" }                : 모든 장에 청크·핵심어가 있는지 확인 → 상태 ready
// 각 단계는 다시 실행해도 같은 결과가 나오도록(먼저 지우고 다시 넣도록) 만들어, 실패한 단계만 다시 시도할 수 있다.
//
// 색인이 끝나도 바로 운영에 쓰이지 않는다(is_active는 그대로 false). 관리자가 결과를 확인한 뒤
// /api/admin/documents/[id]/activate 로 "운영에 적용"해야 사용자 화면이 새 문서로 바뀐다.
// 색인이 끝난(ready) 문서는 운영 중이든 아니든 다시 색인할 수 없다. 질문 기록이 그 문서의 장에 연결되어 있고,
// 이전 판(예: 2025)은 새 판에 문제가 생겼을 때 되돌릴 대상이므로 그대로 보존해야 하기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────
import { PDFDocument } from "pdf-lib";
import { errorResponse, requireAdmin } from "@/lib/auth";
import { buildChapterKeywords, loadChapterTexts } from "@/lib/keywords";
import { serviceSupabase } from "@/lib/supabase";
import { chunkPages } from "@/lib/text";
import { detectChapterHeadings, embed, parsePdf } from "@/lib/upstage";

// Vercel 서버 함수가 실행될 수 있는 최대 시간(초). 단계 하나(장 하나)가 이 안에 끝나도록 단계를 나눴다.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
type Step = { step?: "outline" | "chapter" | "keywords" | "finish"; chapterId?: string };
type Supabase = ReturnType<typeof serviceSupabase>;
type ChapterRow = { id: string; title: string; chapter_number: string; page_from: number; page_to: number; display_order: number };

// Upstage Document Parse는 한 번에 100쪽까지만 받으므로 PDF를 100쪽 단위로 나누어 보낸다.
const PARSE_PAGE_LIMIT = 100;
// 목차를 찾으려고 파싱하는 앞부분 쪽 수. 목차 분석(detectChapterHeadings)은 앞 15쪽만 보므로 20쪽이면 충분하다.
const TOC_PAGES = 20;

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

// 업로드 때 Storage에 저장해 둔 PDF를 내려받아 연다. 목차·본문 단계마다 필요하다.
async function loadPdf(supabase: Supabase, storagePath: string) {
  const { data: file, error } = await supabase.storage.from("personnel-pdfs").download(storagePath);
  if (error || !file) throw error ?? new Error("PDF 파일을 읽지 못했습니다.");
  return PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
}

// 문서의 장 목록(목차 순서)
async function loadChapters(supabase: Supabase, documentId: string) {
  const { data, error } = await supabase.from("chapters")
    .select("id, title, chapter_number, page_from, page_to, display_order").eq("document_id", documentId).order("display_order");
  if (error) throw error;
  return (data ?? []) as ChapterRow[];
}

// [1단계] 목차 분석: 앞 20쪽을 파싱해 최상위 장을 찾고, 장과 쪽 범위를 저장한다.
// 같은 문서를 다시 색인하는 경우를 위해 기존 장을 먼저 지운다(연결된 청크·임베딩·핵심어도 cascade로 함께 지워진다).
async function outline(supabase: Supabase, documentId: string, storagePath: string) {
  await supabase.from("documents").update({ status: "processing", error: null }).eq("id", documentId);
  const source = await loadPdf(supabase, storagePath);
  const pageCount = source.getPageCount();
  const tocPages = await parseRange(source, 1, Math.min(TOC_PAGES, pageCount));
  const ranges = rangesFromHeadings(await detectChapterHeadings(tocPages, pageCount), pageCount);
  const { error: deleteError } = await supabase.from("chapters").delete().eq("document_id", documentId);
  if (deleteError) throw deleteError;
  const { error } = await supabase.from("chapters").insert(ranges.map((range, display_order) => ({
    document_id: documentId,
    chapter_number: range.chapterNumber,
    title: range.title,
    page_from: range.pageFrom,
    page_to: range.pageTo,
    display_order,
  })));
  if (error) throw error;
  return { pageCount, chapters: await loadChapters(supabase, documentId) };
}

// [2단계] 장 본문: 그 장의 쪽만 100쪽 단위로 파싱 → 청크로 자르기 → 청크 저장 → passage 모델로 임베딩 저장.
// 다시 실행해도 되도록 그 장의 기존 청크를 먼저 지운다(임베딩은 cascade로 함께 지워진다).
async function indexChapter(supabase: Supabase, documentId: string, storagePath: string, chapter: ChapterRow) {
  const { error: deleteError } = await supabase.from("chunks").delete().eq("chapter_id", chapter.id);
  if (deleteError) throw deleteError;
  const source = await loadPdf(supabase, storagePath);
  const pages = [];
  for (let pageFrom = chapter.page_from; pageFrom <= chapter.page_to; pageFrom += PARSE_PAGE_LIMIT) {
    pages.push(...await parseRange(source, pageFrom, Math.min(pageFrom + PARSE_PAGE_LIMIT - 1, chapter.page_to)));
  }
  const chunks = chunkPages(pages);
  if (!chunks.length) throw new Error(`'${chapter.title}' 장에서 저장할 본문을 찾지 못했습니다.`);
  // heading(꼭지 제목)에는 장 제목을 넣어 화면의 "확인한 근거"에 표시한다. ord는 장 안에서의 청크 순서다.
  const { data: inserted, error: chunkError } = await supabase.from("chunks")
    .insert(chunks.map((chunk, ord) => ({
      document_id: documentId,
      chapter_id: chapter.id,
      ord,
      heading: chapter.title,
      page_from: chunk.pageFrom,
      page_to: chunk.pageTo,
      content: chunk.content,
    })))
    .select("id, content");
  if (chunkError || !inserted) throw chunkError ?? new Error("청크를 저장하지 못했습니다.");
  // 어떤 모델로 만든 벡터인지 model 열에 함께 남긴다(모델을 바꾸면 다시 만들어야 하므로).
  const model = process.env.UPSTAGE_PASSAGE_MODEL ?? "embedding-passage";
  const vectors = await embed(inserted.map((chunk) => chunk.content), model);
  const { error: embeddingError } = await supabase.from("embeddings")
    .insert(inserted.map((chunk, index) => ({ chunk_id: chunk.id, embedding: vectors[index], model })));
  if (embeddingError) throw embeddingError;
  return { chunkCount: inserted.length };
}

// [3단계] 장 핵심어: 문서 전체 청크로 그 장의 핵심어 사전을 만들어 저장한다(src/lib/keywords.ts).
async function indexKeywords(supabase: Supabase, documentId: string, chapter: ChapterRow) {
  const chapters = await loadChapters(supabase, documentId);
  const allChapterTexts = await loadChapterTexts(supabase, documentId, chapters.map((item) => item.id));
  const index = chapters.findIndex((item) => item.id === chapter.id);
  const otherTitles = chapters.filter((item) => item.id !== chapter.id).map((item) => item.title);
  const keywords = await buildChapterKeywords(chapter.title, otherTitles, allChapterTexts[index], allChapterTexts);
  if (!keywords.length) throw new Error(`'${chapter.title}' 장의 핵심어를 고르지 못했습니다.`);
  const { error: deleteError } = await supabase.from("chapter_keywords").delete().eq("chapter_id", chapter.id);
  if (deleteError) throw deleteError;
  const { error } = await supabase.from("chapter_keywords").insert(keywords.map((keyword) => ({ ...keyword, chapter_id: chapter.id })));
  if (error) throw error;
  return { keywordCount: keywords.length };
}

// [4단계] 마무리: 모든 장에 청크와 핵심어가 있는지 확인한 뒤 ready로 바꾼다. 운영 적용(활성화)은 하지 않는다.
async function finish(supabase: Supabase, documentId: string) {
  const chapters = await loadChapters(supabase, documentId);
  if (!chapters.length) throw new Error("저장된 장이 없습니다. 목차 분석부터 다시 실행하세요.");
  for (const chapter of chapters) {
    const chunks = await supabase.from("chunks").select("id", { count: "exact", head: true }).eq("chapter_id", chapter.id);
    const keywords = await supabase.from("chapter_keywords").select("id", { count: "exact", head: true }).eq("chapter_id", chapter.id);
    if (!chunks.count || !keywords.count) throw new Error(`'${chapter.title}' 장의 본문 또는 핵심어가 비어 있습니다.`);
  }
  const { error } = await supabase.from("documents").update({ status: "ready", processed_at: new Date().toISOString() }).eq("id", documentId);
  if (error) throw error;
  return { chapterCount: chapters.length };
}

export async function POST(request: Request, { params }: Params) {
  try {
    // 색인은 비용이 드는 작업이므로 관리자만 실행할 수 있다.
    await requireAdmin(request);
    const { id } = await params;
    const { step, chapterId } = await request.json() as Step;
    const supabase = serviceSupabase();
    const { data: document, error: documentError } = await supabase.from("documents").select("id, storage_path, is_active, status").eq("id", id).single();
    if (documentError) throw documentError;
    if (document.is_active || document.status === "ready") throw new Error("색인이 끝난 문서는 다시 색인할 수 없습니다. 새 PDF로 올려 주세요.");

    if (step === "outline") return Response.json(await outline(supabase, id, document.storage_path));
    if (step === "finish") return Response.json(await finish(supabase, id));
    const chapter = (await loadChapters(supabase, id)).find((item) => item.id === chapterId);
    if (!chapter) throw new Error("이 문서의 장이 아닙니다.");
    if (step === "chapter") return Response.json(await indexChapter(supabase, id, document.storage_path, chapter));
    if (step === "keywords") return Response.json(await indexKeywords(supabase, id, chapter));
    throw new Error("알 수 없는 색인 단계입니다.");
  } catch (error) {
    // 실패하면 문서 상태를 failed로 바꾸고 오류 메시지(최대 500자)를 남긴다. 관리자 화면 문서 목록에 표시된다.
    // 단, 색인이 끝난 문서(운영 중이거나 되돌리기용 이전 판)는 다시 색인하려다 거절된 것이므로 상태를 바꾸지 않는다.
    try {
      const { id } = await params;
      await serviceSupabase().from("documents").update({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "처리 실패" }).eq("id", id).eq("is_active", false).neq("status", "ready");
    } catch { /* 상태 기록마저 실패해도 원래 오류를 돌려주는 편이 원인 파악에 더 유용하므로 여기서는 무시한다. */ }
    return errorResponse(error);
  }
}
