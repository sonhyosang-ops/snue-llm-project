// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/documents/[id]/activate — 문서를 운영에 적용(활성화) (관리자 전용)
//
// 사용자 화면은 활성 문서(is_active = true) 하나만 보여 주고 그 안에서만 검색한다.
// 새 판(예: 2027)을 색인한 뒤 관리자가 확인하고 이 API로 적용한다. 이전 판도 ready 상태로 남아 있으므로,
// 새 판에 문제가 있으면 이전 판(예: 2025)을 다시 적용해 바로 되돌릴 수 있다.
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
    const { data: document, error: documentError } = await supabase.from("documents").select("id, status").eq("id", id).single();
    if (documentError) throw documentError;
    if (document.status !== "ready") throw new Error("색인이 끝난 문서만 운영에 적용할 수 있습니다.");
    // 새 문서를 먼저 활성화한 뒤 나머지를 끈다. 순서를 반대로 하면 잠깐 동안 활성 문서가 하나도 없어
    // 그 사이에 접속한 사용자가 "활성화된 문서가 없습니다"를 보게 된다.
    // (잠깐 두 문서가 함께 활성인 동안에는 /api/chapters가 가장 최근에 처리된 문서 하나만 고른다.)
    const { error: activateError } = await supabase.from("documents").update({ is_active: true }).eq("id", id);
    if (activateError) throw activateError;
    const { error: deactivateError } = await supabase.from("documents").update({ is_active: false }).neq("id", id);
    if (deactivateError) throw deactivateError;
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
