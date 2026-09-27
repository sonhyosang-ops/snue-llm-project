export type Role = "admin" | "user";

export type Chapter = {
  id: string;
  title: string;
  chapter_number: string;
  page_from: number;
  page_to: number;
  display_order: number;
  document_id: string;
};

export type Citation = {
  chunkId: string;
  pageFrom: number;
  pageTo: number;
  heading: string;
  excerpt: string;
  score: number;
};

export type AskResult =
  | { type: "answer"; answer: string; citations: Citation[]; keywords: string[] }
  | { type: "suggestion"; keywords: string[]; chapter: Pick<Chapter, "id" | "title" | "chapter_number"> }
  | { type: "not_found"; keywords: string[]; message: string };
