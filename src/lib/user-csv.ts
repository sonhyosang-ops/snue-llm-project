// ─────────────────────────────────────────────────────────────────────────────
// user-csv.ts — 허용 사용자 명단 CSV를 읽고 검사한다(DB에 쓰지 않는 순수 함수만 모음).
//
// 관리자가 올린 CSV에서 "메일 주소"와 "역할" 두 열만 꺼내 확인하고, 나머지 열(이름, 학년 등)은 무시한다.
// 등록할 수 있는 줄과 건너뛸 줄(이유 포함)로 나누기까지만 하고, 실제 저장은 API 라우트
// (src/app/api/admin/users/import/route.ts)가 한다. 그래서 DB 없이도 이 파일만으로 시험할 수 있다.
// ─────────────────────────────────────────────────────────────────────────────
import type { Role } from "@/lib/types";

// CSV 글을 칸 배열로 나눈다. 엑셀이 저장하는 일반적인 CSV 규칙을 따른다.
//   - 쉼표로 칸을 나누고, 줄바꿈(\n 또는 \r\n)으로 줄을 나눈다.
//   - 큰따옴표로 감싼 칸 안의 쉼표·줄바꿈은 칸의 일부다. 칸 안의 큰따옴표는 ""로 두 번 쓴다.
//   - 맨 앞의 BOM(엑셀 UTF-8 저장 표시 글자)은 지운다. 모든 칸이 빈 줄은 버린다.
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (input[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((cells) => cells.some((value) => value.trim()));
}

// 머리글 이름과 역할 표기를 비교하기 좋게 만든다: 공백 제거 + 소문자.
const normalize = (value: string) => value.replace(/\s/g, "").toLowerCase();

// 메일 열·역할 열로 인정하는 머리글 이름(normalize 후 비교)
const EMAIL_HEADERS = ["email", "e-mail", "메일", "이메일", "메일주소", "이메일주소"];
const ROLE_HEADERS = ["role", "역할", "권한"];

// 역할 칸에 쓸 수 있는 표기 → 저장 값. 한글·영문 모두 받는다.
const ROLE_NAMES: Record<string, Role> = {
  admin: "admin", 관리자: "admin",
  leader: "leader", 교장: "leader", 교감: "leader", "교장·교감": "leader", 교장교감: "leader", "교장/교감": "leader",
  user: "user", 교사: "user",
};

export type UserRow = { email: string; role: Role };
export type SkippedRow = { line: number; email: string; reason: string };
export type UserCsvResult = { rows: UserRow[]; skipped: SkippedRow[]; notice: string };

// CSV 칸 배열을 "등록할 줄"과 "건너뛸 줄"로 나눈다.
//   - domain     : 허용 메일 도메인(예: baegotnuri.es.kr)
//   - adminEmail : 업로드하는 관리자 본인 메일. 자기 권한을 내리는 줄을 막는 데 쓴다.
// 첫 줄에 "이메일"·"역할" 같은 머리글이 있으면 그 열을 쓰고, 첫 줄이 바로 메일이면 1열=메일, 2열=역할로 본다.
export function interpretUserCsv(table: string[][], domain: string, adminEmail: string): UserCsvResult {
  const header = (table[0] ?? []).map(normalize);
  let emailIndex = header.findIndex((name) => EMAIL_HEADERS.includes(name));
  let roleIndex = header.findIndex((name) => ROLE_HEADERS.includes(name));
  let firstDataRow = 1;
  if (emailIndex < 0) {
    if (!(table[0]?.[0] ?? "").includes("@")) throw new Error("첫 줄에서 '이메일' 열을 찾지 못했습니다. 첫 줄을 '이메일,역할'로 적어 주세요.");
    emailIndex = 0; roleIndex = 1; firstDataRow = 0;
  }
  const notice = roleIndex < 0 ? "역할 열이 없어 모든 사용자를 교사로 등록합니다." : "";

  const rows: UserRow[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();
  table.slice(firstDataRow).forEach((cells, offset) => {
    // 화면에 보여 줄 줄 번호는 엑셀에서 보이는 번호(1부터)와 맞춘다.
    const line = firstDataRow + offset + 1;
    const email = (cells[emailIndex] ?? "").trim().toLowerCase();
    const rawRole = roleIndex < 0 ? "" : (cells[roleIndex] ?? "").trim();
    // 역할 칸이 비어 있으면 가장 흔한 교사로 등록한다.
    const role = rawRole ? ROLE_NAMES[normalize(rawRole)] : "user";
    if (!email) return skipped.push({ line, email: "", reason: "메일 주소가 비어 있음" });
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !email.endsWith(`@${domain}`)) return skipped.push({ line, email, reason: `@${domain} 메일이 아님` });
    if (!role) return skipped.push({ line, email, reason: `알 수 없는 역할 '${rawRole}' (관리자 / 교장·교감 / 교사 중 하나)` });
    if (seen.has(email)) return skipped.push({ line, email, reason: "파일 안에서 중복(앞 줄의 내용으로 등록)" });
    if (email === adminEmail && role !== "admin") return skipped.push({ line, email, reason: "자기 자신의 관리자 권한은 내릴 수 없음" });
    seen.add(email);
    rows.push({ email, role });
  });
  return { rows, skipped, notice };
}
