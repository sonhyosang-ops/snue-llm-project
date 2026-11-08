// ─────────────────────────────────────────────────────────────────────────────
// types.ts — 화면과 서버 API가 함께 쓰는 데이터 모양(타입) 정의
//
// 자료 구조: 매뉴얼(manuals) → 판(documents, 업로드한 PDF) → 장(chapters, 검색 범위)
// 매뉴얼마다 운영 중인 판은 하나이며, 사용자 화면에는 매뉴얼별로 그 판의 장 목록이 보인다.
// ─────────────────────────────────────────────────────────────────────────────

// 사용자 역할(3단계). DB allowed_users.role에 이 값이 저장된다.
//   admin  (관리자)   : 사용자 등록·문서 업로드, 전체 질문 기록을 질문자까지 검색
//   leader (교장·교감) : 전체 질문 기록을 열람·검색하되 누가 물었는지는 볼 수 없음
//   user   (교사)     : 질문하고 자기 질문 기록만 봄
export type Role = "admin" | "leader" | "user";

// 화면에 보여 줄 역할 이름
export const ROLE_LABELS: Record<Role, string> = { admin: "관리자", leader: "교장·교감", user: "교사" };

// 장(chapter): 판(문서)의 최상위 단위이자 이 앱의 "검색 범위". DB chapters 테이블의 한 행과 같다.
export type Chapter = {
  id: string;
  title: string;
  chapter_number: string;
  page_from: number;
  page_to: number;
  display_order: number;
  document_id: string;
};

// 다른 화면에서 장을 가리킬 때 쓰는 짧은 모양. 어느 매뉴얼의 장인지(manualTitle)를 함께 담는다.
export type ChapterRef = Pick<Chapter, "id" | "title" | "chapter_number"> & { manualTitle: string };

// 사용자 화면 왼쪽 목록의 매뉴얼 하나: 운영 중인 판과 그 장 목록(/api/chapters)
export type ManualTree = {
  id: string;
  title: string;
  document: { id: string; title: string; year: string | null };
  chapters: Chapter[];
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
  chapter: ChapterRef | null;
};

// 전체 질문 기록 검색 결과 한 건(/api/records). 관리자와 교장·교감이 본다.
//   - questioner : 질문자 메일. 관리자에게만 들어 있고, 교장·교감에게는 서버가 아예 넣지 않는다.
//   - date       : 관리자는 "YYYY-MM-DD HH:MM", 교장·교감은 "YYYY-MM-DD"(시각으로 사람을 짐작하지 못하게)
export type RecordItem = {
  id: string;
  question: string;
  answer: string;
  date: string;
  chapter: Omit<ChapterRef, "id"> | null;
  questioner?: string;
};

// 질문 API(/api/ask)의 응답. type 값에 따라 화면이 다르게 그려진다.
//   - answer     : 선택한 장에서 근거를 찾아 답변함
//   - suggestion : 질문 핵심어가 다른 장(다른 매뉴얼의 장일 수도 있음)에 있어 장 이동을 제안함(사용자가 동의하면 다시 질문)
//   - not_found  : 관련 장이나 충분히 가까운 근거를 찾지 못함
//   rewrittenQuestion: 최근 대화를 참고해 서버가 고쳐 쓴 질문(원문과 다를 때만 있음). 화면에 "이렇게 이해했습니다"로 보여 준다.
export type AskResult =
  | { type: "answer"; answer: string; citations: Citation[]; keywords: string[]; rewrittenQuestion?: string }
  | { type: "suggestion"; keywords: string[]; chapter: ChapterRef }
  | { type: "not_found"; keywords: string[]; message: string };

// 목차 분석 초안의 항목 하나(documents.outline_draft). 관리자가 확인·수정한 뒤 확정하면 장이 된다.
//   - level  : 1이 가장 큰 단위(예: "제 1 장", "Ⅰ."), 2는 그 아래(예: "1.", "가.")
//   - number : 번호 표기 그대로(예: "제 1 장", "Ⅰ", "1")
//   - page   : 목차에 인쇄된 쪽 번호(실제 PDF 쪽과 다를 수 있어 보정값 offset을 더해 쓴다)
export type OutlineItem = { level: number; number: string; title: string; page: number };
// 목차 분석 초안 전체. offset은 "실제 PDF 쪽 − 목차에 인쇄된 쪽"의 추정값이다.
export type OutlineDraft = { offset: number; items: OutlineItem[] };
// 관리자가 확정해 보내는 장 하나. pageFrom은 실제 PDF 쪽 번호다.
export type ConfirmedChapter = { number: string; title: string; pageFrom: number };

// ── 문제 풀기(2026-11-08) ──
// 출제 범위. recent: 이 장에서 내가 한 최근 질문의 근거로 출제 / chapter: 이 장 원문에서 무작위로 골라 출제
export type QuizScope = "recent" | "chapter";
// 화면에 보내는 문제 하나. 정답·해설은 들어 있지 않다(채점 뒤 QuizAnswerResult로 받는다).
//   - kind    : ox(O/X) 또는 choice(4지선다)
//   - choices : 4지선다 보기 4개. O/X는 빈 배열
export type QuizQuestion = { id: string; kind: "ox" | "choice"; prompt: string; choices: string[] };
// 장별 누적 성적(내 풀이 기록을 센 것)
export type QuizStats = { total: number; correct: number };
// 채점 결과(/api/quiz/answer). 정답·해설과 함께 근거 원문을 보내 "왜 그런지"를 바로 확인하게 한다.
export type QuizAnswerResult = { correct: boolean; answer: string; explanation: string; citation: Omit<Citation, "score">; stats: QuizStats };
