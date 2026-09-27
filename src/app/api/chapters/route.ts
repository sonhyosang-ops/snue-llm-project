import { errorResponse, requireUser } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const supabase = serviceSupabase();
    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("id, title, year")
      .eq("is_active", true)
      .eq("status", "ready")
      .order("processed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (documentError) throw documentError;
    if (!document) return Response.json({ role: user.role, document: null, chapters: [] });

    const { data: chapters, error } = await supabase
      .from("chapters")
      .select("id, title, chapter_number, page_from, page_to, display_order, document_id")
      .eq("document_id", document.id)
      .order("display_order");
    if (error) throw error;
    return Response.json({ role: user.role, document, chapters: chapters ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
