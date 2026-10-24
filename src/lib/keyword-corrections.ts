// ─────────────────────────────────────────────────────────────────────────────
// keyword-corrections.ts — 사람이 검토한 핵심어 수정 사항(다음 문서에도 자동 적용)
//
// 2026-10-24 관리자가 docs/핵심어_미리보기_2026-10-24.xlsx로 핵심어 사전을 검토하며
//   - 쓸모없는 낱말을 제외(EXCLUDED_TERMS)하고
//   - 글자 인식 오류·잘린 낱말을 바르게 고쳤다(TERM_FIXES).
// 개정판 PDF(예: 2027)를 새로 색인하면 사전이 자동으로 다시 만들어지므로, 같은 오류가 또 나올 수 있다.
// 그래서 그 검토 결과를 여기 모아 두고 새 사전을 만들 때마다 자동으로 적용한다(src/lib/keywords.ts).
// 다음 검토에서 새로 고친 내용이 생기면 이 목록에 덧붙이면 된다.
// ─────────────────────────────────────────────────────────────────────────────

// 사전에서 항상 빼는 낱말
export const EXCLUDED_TERMS = new Set(["점수임", "학교임", "행추", "임용기인명", "기간성조회", "결임해제일"]);

// 잘못 뽑힌 낱말 → 바른 낱말
export const TERM_FIXES: Record<string, string> = {
  출산휴: "출산휴가",
  돌볼: "돌봄",
  외부강: "외부강의",
  특별휴: "특별휴가",
  일반병: "일반병가",
  반일연: "반일연가",
  다면평: "다면평가자",
  평정점임: "평정점",
  말소함: "말소",
  징계결: "징계결과",
  혈중알콜농: "혈중알콜농도",
  신청구건: "신청건수",
  초입호봉대상자관리: "초임호봉대상자관리",
  정학사: "장학사",
  획정연: "획정",
  호경학점일수: "호봉확정일수",
  복지일자: "복직일자",
};

type Keyword = { term: string; frequency: number; score: number };

// 점수 순으로 정렬된 핵심어 목록에 검토 결과를 적용한다.
// 고친 낱말이 이미 목록에 있는 낱말과 같아지면(예: "출산휴" → "출산휴가") 같은 장에 같은 낱말이 두 번 들어갈 수 없으므로
// 점수가 더 높은 앞쪽 하나만 남긴다(DB의 unique(chapter_id, term) 제약과도 맞춘다).
export function applyKeywordCorrections(keywords: Keyword[]) {
  const seen = new Set<string>();
  const result: Keyword[] = [];
  for (const keyword of keywords) {
    const term = TERM_FIXES[keyword.term] ?? keyword.term;
    if (EXCLUDED_TERMS.has(term) || seen.has(term)) continue;
    seen.add(term);
    result.push({ ...keyword, term });
  }
  return result;
}
