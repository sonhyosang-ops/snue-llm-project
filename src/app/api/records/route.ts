// ─────────────────────────────────────────────────────────────────────────────
// GET /api/records?q=검색어 — 전체 질문 기록 검색 (관리자, 교장·교감 전용)
//
// 자주 묻는 질문을 파악하고 답변 품질을 점검하기 위한 기능이다. 역할에 따라 보이는 정보가 다르다.
//   - 관리자(admin)    : 질문·답변 + 질문자 메일 + 날짜·시각. 검색어로 질문자 메일도 찾을 수 있다.
//   - 교장·교감(leader): 질문·답변 + 날짜만. 누가 물었는지는 알 수 없다.
//   - 교사(user)       : 이 API를 쓸 수 없다(자기 기록은 /api/messages로 본다).
//
// 개인정보 보호 원칙: 교장·교감에게는 질문자 정보를 "화면에서 숨기는" 것이 아니라 서버가 처음부터 조회하지도,
// 내려보내지도 않는다(브라우저 개발자 도구로도 볼 수 없음). 작은 학교에서는 질문 시각만으로도 사람을 짐작할 수 있어
// 시각도 빼고 날짜만 보낸다. 검색어가 없으면 최신 50건, 있으면 검색어가 들어간 최신 50건을 돌려준다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireRecordViewer } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";
import type { RecordItem } from "@/lib/types";

type Row = { id: string; question: string; answer: string; created_at: string; chapter: RecordItem["chapter"]; user_id?: string };

export async function GET(request: Request) {
  try {
    const viewer = await requireRecordViewer(request);
    const isAdmin = viewer.role === "admin";
    const supabase = serviceSupabase();
    // 검색어는 Supabase의 or(...) 필터 문자열 안에 들어간다. 그 문법에서 특별한 뜻을 가진 문자
    // (쉼표·괄호·따옴표·와일드카드·역슬래시)를 지워, 검색어가 필터 구조를 바꾸지 못하게 한다.
    const keyword = (new URL(request.url).searchParams.get("q") ?? "").replace(/[,()"*%\\]/g, " ").trim().slice(0, 50);

    // 관리자에게만: 로그인 계정 목록(Supabase Auth)에서 "사용자 id → 메일" 표를 만든다.
    // messages 테이블에는 user_id만 있고 메일은 Auth에 있으므로, 관리자 키로 Auth 사용자 목록을 읽는다.
    const emails = new Map<string, string>();
    if (isAdmin) {
      const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      for (const user of data.users) if (user.email) emails.set(user.id, user.email.toLowerCase());
    }

    // 검색 조건: 질문 또는 답변에 검색어가 들어 있으면 찾는다(ilike = 대소문자 무시 "포함" 검색).
    // 관리자는 질문자 메일에 검색어가 들어 있는 사람의 질문도 함께 찾는다.
    const filters = keyword ? [`question.ilike."%${keyword}%"`, `answer.ilike."%${keyword}%"`] : [];
    if (isAdmin && keyword) {
      const ids = [...emails].filter(([, email]) => email.includes(keyword.toLowerCase())).map(([id]) => id);
      if (ids.length) filters.push(`user_id.in.(${ids.join(",")})`);
    }

    // user_id 열은 관리자일 때만 조회한다. 교장·교감 요청에서는 DB에서부터 읽지 않는다.
    let query = supabase
      .from("messages")
      .select(`id, question, answer, created_at, chapter:chapters(title, chapter_number)${isAdmin ? ", user_id" : ""}`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (filters.length) query = query.or(filters.join(","));
    const { data, error } = await query;
    if (error) throw error;

    const records: RecordItem[] = ((data ?? []) as unknown as Row[]).map((row) => {
      // 날짜는 한국 시간으로 바꾼다. "sv-SE" 형식은 "2026-10-24 14:05:33"처럼 정렬하기 좋은 모양이다.
      const local = new Date(row.created_at).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
      return {
        id: row.id,
        question: row.question,
        answer: row.answer,
        chapter: row.chapter,
        date: isAdmin ? local.slice(0, 16) : local.slice(0, 10),
        ...(isAdmin ? { questioner: emails.get(row.user_id ?? "") ?? "(알 수 없음)" } : {}),
      };
    });
    return Response.json({ records, showsQuestioner: isAdmin });
  } catch (error) {
    return errorResponse(error);
  }
}
