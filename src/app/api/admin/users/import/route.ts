// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/import — CSV로 허용 사용자 명단을 한꺼번에 등록 (관리자 전용)
//
// 요청: { csv: "이메일,역할\nkim@…,교사\n…" } — 관리자 화면이 파일을 글자로 읽어 보낸다.
// 처리: CSV에서 메일 주소와 역할 두 열만 확인하고(src/lib/user-csv.ts), 통과한 줄만 allowed_users에 등록한다.
//       이미 있는 메일은 역할을 CSV 값으로 바꾸고 다시 활성화한다. CSV에 없는 기존 사용자는 그대로 둔다(지우지 않음).
// 응답: 새로 등록한 수, 역할을 갱신한 수, 건너뛴 줄 목록(줄 번호·메일·이유)
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";
import { interpretUserCsv, parseCsv } from "@/lib/user-csv";

// 한 번에 받을 최대 줄 수. 학교 규모에서는 충분하고, 실수로 엉뚱한 큰 파일을 올렸을 때를 막는다.
const MAX_ROWS = 2000;

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const { csv } = await request.json() as { csv?: string };
    if (!csv?.trim()) throw new Error("CSV 내용이 비어 있습니다.");
    const table = parseCsv(csv);
    if (table.length > MAX_ROWS + 1) throw new Error(`한 번에 ${MAX_ROWS}줄까지만 올릴 수 있습니다.`);

    const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "baegotnuri.es.kr";
    const { rows, skipped, notice } = interpretUserCsv(table, domain, admin.email);

    // 새로 등록하는 사람과 역할만 바뀌는 사람을 구분해 알려 주려고 기존 명단을 먼저 읽는다.
    const supabase = serviceSupabase();
    const { data: existing, error: existingError } = await supabase.from("allowed_users").select("email");
    if (existingError) throw existingError;
    const known = new Set((existing ?? []).map((user) => user.email));

    // 통과한 줄을 한 번에 저장한다. upsert는 메일(기본 키)이 있으면 고치고, 없으면 새로 넣는다.
    if (rows.length) {
      const { error } = await supabase.from("allowed_users").upsert(rows.map((row) => ({ ...row, enabled: true })));
      if (error) throw error;
    }
    const updated = rows.filter((row) => known.has(row.email)).length;
    return Response.json({ created: rows.length - updated, updated, skipped, notice });
  } catch (error) {
    return errorResponse(error);
  }
}
