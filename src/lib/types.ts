// ─────────────────────────────────────────────────────────────────────────────
// types.ts — 화면과 서버 API가 함께 쓰는 데이터 모양(타입) 정의
// ─────────────────────────────────────────────────────────────────────────────

// 사용자 역할(3단계). DB allowed_users.role에 이 값이 저장된다.
//   admin  (관리자)   : 사용자 등록·문서 업로드, 전체 질문 기록을 질문자까지 검색
//   leader (교장·교감) : 전체 질문 기록을 열람·검색하되 누가 물었는지는 볼 수 없음
//   user   (교사)     : 질문하고 자기 질문 기록만 봄
export type Role = "admin" | "leader" | "user";

// 화면에 보여 줄 역할 이름
export const ROLE_LABELS: Record<Role, string> = { admin: "관리자", leader: "교장·교감", user: "교사" };

// 장(chapter): 문서의 최상위 단위이자 이 앱의 "검색 범위". DB chapters 테이블의 한 행과 같다.
export type Chapter = {
  id: string;
  title: string;
  chapter_number: string;
  page_from: number;
  page_to: number;
  display_order: number;
  document_id: string;
};

// 답변 아래 "확인한 근거" 목록의 한 항목. 답변 속 [1], [2] 번호와 같은 순서로 만들어진다.
export type Citation = {
  chunkId: string;
  pageFrom: number;
  pageTo: number;
  heading: string;
  excerpt: string; // 근거 원문 전체(cleanChunk로 정리한 마크다운. 표·글머리표 포함)
  score: number;   // 질문과의 유사도(1에 가까울수록 비슷함)
};

// 내 질문 기록 한 건(/api/messages). 질문할 때 messages 테이블에 저장된 내용을 그대로 다시 보여 준다.
// 근거(citations)도 그때 저장한 것이므로, 다시 볼 때 모델을 부르지 않고 당시 답변·근거를 그대로 띄울 수 있다.
export type HistoryItem = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  created_at: string;
  chapter: Pick<Chapter, "id" | "title" | "chapter_number"> | null;
};

// 전체 질문 기록 검색 결과 한 건(/api/records). 관리자와 교장·교감이 본다.
//   - questioner : 질문자 메일. 관리자에게만 들어 있고, 교장·교감에게는 서버가 아예 넣지 않는다.
//   - date       : 관리자는 "YYYY-MM-DD HH:MM", 교장·교감은 "YYYY-MM-DD"(시각으로 사람을 짐작하지 못하게)
export type RecordItem = {
  id: string;
  question: string;
  answer: string;
  date: string;
  chapter: Pick<Chapter, "title" | "chapter_number"> | null;
  questioner?: string;
};

// 질문 API(/api/ask)의 응답. type 값에 따라 화면이 다르게 그려진다.
//   - answer     : 선택한 장에서 근거를 찾아 답변함
//   - suggestion : 질문 핵심어가 다른 장에 있어 장 이동을 제안함(사용자가 동의하면 다시 질문)
//   - not_found  : 관련 장이나 충분히 가까운 근거를 찾지 못함
export type AskResult =
  | { type: "answer"; answer: string; citations: Citation[]; keywords: string[] }
  | { type: "suggestion"; keywords: string[]; chapter: Pick<Chapter, "id" | "title" | "chapter_number"> }
  | { type: "not_found"; keywords: string[]; message: string };
