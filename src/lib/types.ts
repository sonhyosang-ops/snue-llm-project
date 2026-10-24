// ─────────────────────────────────────────────────────────────────────────────
// types.ts — 화면과 서버 API가 함께 쓰는 데이터 모양(타입) 정의
// ─────────────────────────────────────────────────────────────────────────────

// 사용자 역할. admin은 사용자 등록·문서 업로드를 할 수 있고, user는 질문만 할 수 있다.
export type Role = "admin" | "user";

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
  excerpt: string; // 근거 원문 앞부분(최대 240자)
  score: number;   // 질문과의 유사도(1에 가까울수록 비슷함)
};

// 질문 API(/api/ask)의 응답. type 값에 따라 화면이 다르게 그려진다.
//   - answer     : 선택한 장에서 근거를 찾아 답변함
//   - suggestion : 질문 핵심어가 다른 장에 있어 장 이동을 제안함(사용자가 동의하면 다시 질문)
//   - not_found  : 관련 장이나 충분히 가까운 근거를 찾지 못함
export type AskResult =
  | { type: "answer"; answer: string; citations: Citation[]; keywords: string[] }
  | { type: "suggestion"; keywords: string[]; chapter: Pick<Chapter, "id" | "title" | "chapter_number"> }
  | { type: "not_found"; keywords: string[]; message: string };
