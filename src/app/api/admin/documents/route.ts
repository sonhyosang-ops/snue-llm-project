import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

const MAX_FILE_SIZE = 30 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const form = await request.formData();
    const file = form.get("file");
    const title = String(form.get("title") ?? "").trim();
    const year = String(form.get("year") ?? "2025").trim();
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) throw new Error("PDF 파일만 업로드할 수 있습니다.");
    if (file.size > MAX_FILE_SIZE) throw new Error("PDF는 30MB 이하만 업로드할 수 있습니다.");
    if (!title) throw new Error("문서 제목을 입력하세요.");

    const supabase = serviceSupabase();
    const { data: document, error: insertError } = await supabase
      .from("documents")
      .insert({ title, year, storage_path: "pending", created_by: admin.id })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const storagePath = `${document.id}/source.pdf`;
    const { error: uploadError } = await supabase.storage.from("personnel-pdfs").upload(storagePath, file, { contentType: "application/pdf", upsert: false });
    if (uploadError) {
      await supabase.from("documents").delete().eq("id", document.id);
      throw uploadError;
    }
    const { error: updateError } = await supabase.from("documents").update({ storage_path: storagePath }).eq("id", document.id);
    if (updateError) throw updateError;
    return Response.json({ id: document.id });
  } catch (error) {
    return errorResponse(error);
  }
}
