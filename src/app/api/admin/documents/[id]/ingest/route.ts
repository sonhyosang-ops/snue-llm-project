import { PDFDocument } from "pdf-lib";
import { errorResponse, requireAdmin } from "@/lib/auth";
import { chapterKeywords, chunkPages } from "@/lib/text";
import { serviceSupabase } from "@/lib/supabase";
import { detectChapterHeadings, embed, parsePdf } from "@/lib/upstage";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
const PARSE_PAGE_LIMIT = 100;

function rangesFromHeadings(headings: { title: string; chapterNumber: string; pageFrom: number }[], totalPages: number) {
  if (!headings.length) return [{ title: "전체", chapterNumber: "", pageFrom: 1, pageTo: totalPages }];
  return headings.map((heading, index) => ({ ...heading, pageTo: (headings[index + 1]?.pageFrom ?? totalPages + 1) - 1 }));
}

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
    await requireAdmin(request);
    const { id } = await params;
    const supabase = serviceSupabase();
    const { data: document, error: documentError } = await supabase.from("documents").select("id, title, storage_path").eq("id", id).single();
    if (documentError) throw documentError;

    await supabase.from("documents").update({ status: "processing", error: null }).eq("id", id);
    const { data: file, error: downloadError } = await supabase.storage.from("personnel-pdfs").download(document.storage_path);
    if (downloadError || !file) throw downloadError ?? new Error("PDF 파일을 읽지 못했습니다.");

    const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    const pageCount = source.getPageCount();
    const tocPages = await parseRange(source, 1, Math.min(PARSE_PAGE_LIMIT, pageCount));
    const headings = await detectChapterHeadings(tocPages, pageCount);
    const ranges = rangesFromHeadings(headings, pageCount);
    const drafts = [] as { title: string; chapterNumber: string; pageFrom: number; pageTo: number; pages: Awaited<ReturnType<typeof parsePdf>> }[];
    for (const range of ranges) {
      const chapterPages = tocPages.filter((page) => page.page >= range.pageFrom && page.page <= Math.min(range.pageTo, PARSE_PAGE_LIMIT));
      for (let pageFrom = Math.max(range.pageFrom, PARSE_PAGE_LIMIT + 1); pageFrom <= range.pageTo; pageFrom += PARSE_PAGE_LIMIT) {
        chapterPages.push(...await parseRange(source, pageFrom, Math.min(pageFrom + PARSE_PAGE_LIMIT - 1, range.pageTo)));
      }
      drafts.push({ ...range, pages: chapterPages });
    }
    const prepared = drafts.map((draft) => ({ ...draft, chunks: chunkPages(draft.pages) })).filter((draft) => draft.chunks.length);
    if (!prepared.length) throw new Error("저장할 청크를 만들지 못했습니다.");

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

    const allChapterTexts = prepared.map((draft) => draft.chunks.map((chunk) => chunk.content));
    for (const chapter of chapters) {
      const draft = prepared.find((item, index) => index === chapter.display_order);
      if (!draft) continue;
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

      const vectors = await embed(insertedChunks.map((chunk) => chunk.content), process.env.UPSTAGE_PASSAGE_MODEL ?? "embedding-passage");
      const { error: embeddingError } = await supabase.from("embeddings").insert(insertedChunks.map((chunk, index) => ({
        chunk_id: chunk.id,
        embedding: vectors[index],
        model: process.env.UPSTAGE_PASSAGE_MODEL ?? "embedding-passage",
      })));
      if (embeddingError) throw embeddingError;

      const keywords = chapterKeywords(draft.chunks.map((chunk) => chunk.content), allChapterTexts);
      const { error: keywordError } = await supabase.from("chapter_keywords").insert(keywords.map((keyword) => ({ ...keyword, chapter_id: chapter.id })));
      if (keywordError) throw keywordError;
    }

    await supabase.from("documents").update({ status: "ready", is_active: true, processed_at: new Date().toISOString() }).eq("id", id);
    await supabase.from("documents").update({ is_active: false }).neq("id", id);
    return Response.json({ ok: true, chapterCount: chapters.length, pageCount });
  } catch (error) {
    try {
      const { id } = await params;
      await serviceSupabase().from("documents").update({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "처리 실패" }).eq("id", id);
    } catch { /* Original error is more useful. */ }
    return errorResponse(error);
  }
}
