// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/documents/[id]/activate — 문서(판)를 운영에 적용(활성화) (관리자 전용)
//
// 사용자 화면은 매뉴얼마다 운영 중인 판(is_active = true) 하나만 보여 주고 그 안에서만 검색한다.
// 새 판(예: 인사업무실무편람 2027)을 색인한 뒤 관리자가 확인하고 이 API로 적용한다.
// 같은 매뉴얼의 다른 판만 운영에서 내리고, 다른 매뉴얼의 운영 판은 그대로 둔다.
// 이전 판도 ready 상태로 남아 있으므로, 새 판에 문제가 있으면 이전 판(예: 2025)을 다시 적용해 바로 되돌릴 수 있다.
// 색인이 끝난(status = ready) 문서만 적용할 수 있다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    await requireAdmin(request);
    const { id } = await params;
    const supabase = serviceSupabase();
    const { data: document, error: documentError } = await supabase.from("documents").select("id, status, manual_id").eq("id", id).single();
    if (documentError) throw documentError;
    if (document.status !== "ready") throw new Error("색인이 끝난 문서만 운영에 적용할 수 있습니다.");
    // 새 판을 먼저 활성화한 뒤 같은 매뉴얼의 나머지 판을 끈다. 순서를 반대로 하면 잠깐 동안 그 매뉴얼의 운영 판이
    // 하나도 없어, 그 사이에 접속한 사용자의 화면에서 매뉴얼이 사라진다.
    // (잠깐 두 판이 함께 활성인 동안에는 /api/chapters가 매뉴얼마다 가장 최근에 처리된 판 하나만 고른다.)
    const { error: activateError } = await supabase.from("documents").update({ is_active: true }).eq("id", id);
    if (activateError) throw activateError;
    const { error: deactivateError } = await supabase.from("documents").update({ is_active: false }).eq("manual_id", document.manual_id).neq("id", id);
    if (deactivateError) throw deactivateError;
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
