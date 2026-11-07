// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chapters — 매뉴얼별로 운영 중인 판과 그 장 목록
//
// 로그인 직후 화면이 가장 먼저 부르는 API다. 응답의 role로 관리자·교장·교감 메뉴를 보여 줄지도 정한다.
// 매뉴얼마다 여러 판을 올릴 수 있지만, 사용자에게는 매뉴얼마다 운영 중(is_active)이고 색인이 끝난(ready) 판 하나만 보여 준다.
// 응답 모양: { role, manuals: [{ id, title, document: { id, title, year }, chapters: [...] }] }
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireUser } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";
import type { Chapter, ManualTree } from "@/lib/types";

type ActiveDocumentRow = { id: string; title: string; year: string | null; processed_at: string | null; manual: { id: string; title: string; display_order: number } | null };

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const supabase = serviceSupabase();
    // 운영 중인 판들을 그 매뉴얼 정보와 함께 불러온다(documents → manuals 외래 키로 묶기).
    const { data: documents, error: documentsError } = await supabase
      .from("documents")
      .select("id, title, year, processed_at, manual:manuals(id, title, display_order)")
      .eq("is_active", true)
      .eq("status", "ready")
      .order("processed_at", { ascending: false });
    if (documentsError) throw documentsError;
    // 운영 적용 직후 아주 잠깐 같은 매뉴얼의 두 판이 함께 활성일 수 있다(activate API 참고).
    // 그럴 때도 매뉴얼이 두 번 보이지 않도록, 매뉴얼마다 가장 최근에 처리된 판 하나만 남긴다(위에서 최신순 정렬).
    const seenManuals = new Set<string>();
    const activeDocuments = ((documents ?? []) as unknown as ActiveDocumentRow[]).filter((document) => {
      if (!document.manual || seenManuals.has(document.manual.id)) return false;
      seenManuals.add(document.manual.id);
      return true;
    });
    if (!activeDocuments.length) return Response.json({ role: user.role, manuals: [] });

    // 그 판들의 장을 한 번에 불러와 판별로 나눈다. 장 목록은 목차 순서(display_order)대로다.
    const { data: chapters, error } = await supabase
      .from("chapters")
      .select("id, title, chapter_number, page_from, page_to, display_order, document_id")
      .in("document_id", activeDocuments.map((document) => document.id))
      .order("display_order");
    if (error) throw error;

    // 매뉴얼은 관리자가 정한 순서(display_order), 같으면 제목 순으로 보여 준다.
    const manuals: ManualTree[] = activeDocuments
      .sort((a, b) => (a.manual!.display_order - b.manual!.display_order) || a.manual!.title.localeCompare(b.manual!.title, "ko"))
      .map((document) => ({
        id: document.manual!.id,
        title: document.manual!.title,
        document: { id: document.id, title: document.title, year: document.year },
        chapters: ((chapters ?? []) as Chapter[]).filter((chapter) => chapter.document_id === document.id),
      }));
    return Response.json({ role: user.role, manuals });
  } catch (error) {
    return errorResponse(error);
  }
}
