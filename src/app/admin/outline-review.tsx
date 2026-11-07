"use client";

// ─────────────────────────────────────────────────────────────────────────────
// outline-review.tsx — 목차 확인 표 (색인 2단계, 관리자 화면 안에서 쓰는 컴포넌트)
//
// 모델이 만든 "목차 초안"을 관리자가 확인·수정해 장을 확정한다.
//   - 장으로 쓸 수준: 목차에 "Ⅰ > 1 > 가"처럼 여러 수준이 있으면 어느 수준을 장으로 쓸지 고른다.
//   - 쪽 번호 보정: 목차에 인쇄된 쪽과 실제 PDF 쪽의 차이(표지·목차 쪽 수만큼 밀림). 하나 바꾸면 모든 장에 적용된다.
//   - 번호·제목·인쇄된 쪽을 고치고, 장을 추가·삭제한다. 끝 쪽은 다음 장 시작 앞 쪽으로 자동 계산된다.
//   - "PDF 보기"는 원본 PDF의 그 쪽을 새 탭에서 열어 시작 쪽이 맞는지 눈으로 확인하게 한다.
// 화면에서 먼저 검사하지만(빠른 안내용), 같은 검사를 서버(/api/admin/documents/[id]/outline)가 다시 한다.
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import type { ConfirmedChapter, OutlineDraft } from "@/lib/types";

type Row = { key: number; number: string; title: string; page: string };
type Props = {
  title: string;
  pageCount: number;
  draft: OutlineDraft;
  pdfUrl: string;
  busy: boolean;
  onConfirm: (chapters: ConfirmedChapter[]) => void;
  onClose: () => void;
};

// 초안에서 고른 수준의 항목만 표의 행으로 만든다. 항목이 하나도 없으면 문서 전체를 장 하나("전체")로 둔다.
function rowsForLevel(draft: OutlineDraft, level: number): Row[] {
  const items = draft.items.filter((item) => item.level === level);
  if (!items.length) return [{ key: 0, number: "", title: "전체", page: String(1 - draft.offset) }];
  return items.map((item, index) => ({ key: index, number: item.number, title: item.title, page: String(item.page) }));
}

export default function OutlineReview({ title, pageCount, draft, pdfUrl, busy, onConfirm, onClose }: Props) {
  const levels = [...new Set(draft.items.map((item) => item.level))].sort();
  const [level, setLevel] = useState(levels[0] ?? 1);
  const [offset, setOffset] = useState(draft.offset);
  const [rows, setRows] = useState<Row[]>(() => rowsForLevel(draft, levels[0] ?? 1));

  // 실제 PDF 시작 쪽 = 목차에 인쇄된 쪽 + 보정값. 끝 쪽 = 다음 장 시작 − 1(마지막 장은 PDF 끝).
  const starts = rows.map((row) => Number(row.page) + offset);
  const ends = starts.map((_, index) => (index + 1 < starts.length ? starts[index + 1] - 1 : pageCount));
  // 행마다 문제를 찾는다(서버 검사와 같은 규칙). 문제가 하나라도 있으면 확정 버튼을 잠근다.
  const problems = rows.map((row, index) => {
    if (!row.title.trim()) return "제목을 입력하세요";
    if (!Number.isInteger(starts[index]) || starts[index] < 1 || starts[index] > pageCount) return `시작 쪽이 1~${pageCount} 범위를 벗어남`;
    if (index > 0 && starts[index] <= starts[index - 1]) return "앞 장보다 시작 쪽이 앞이거나 같음";
    return "";
  });
  const valid = rows.length > 0 && problems.every((problem) => !problem);

  const update = (key: number, field: "number" | "title" | "page", value: string) => setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  const remove = (key: number) => setRows((current) => current.filter((row) => row.key !== key));
  const add = () => setRows((current) => [...current, { key: Date.now(), number: "", title: "", page: "" }]);
  const changeLevel = (next: number) => { setLevel(next); setRows(rowsForLevel(draft, next)); };

  return <section className="admin-panel outline-review" aria-label="목차 확인">
    <h2>목차 확인 · {title}</h2>
    <p className="admin-hint">모델이 목차에서 읽은 초안입니다. 장으로 쓸 수준을 고르고, 제목과 시작 쪽을 확인한 뒤 확정하세요. 확정해야 본문 처리가 시작됩니다. (PDF 전체 {pageCount}쪽)</p>
    <div className="outline-controls">
      <label>장으로 쓸 수준<select value={level} onChange={(event) => changeLevel(Number(event.target.value))}>{(levels.length ? levels : [1]).map((value) => <option key={value} value={value}>{value}단계{value === 1 ? " (가장 큰 단위)" : ""} · {draft.items.filter((item) => item.level === value).length}개</option>)}</select></label>
      <label>쪽 번호 보정(실제 PDF 쪽 − 목차의 쪽)<input type="number" value={offset} onChange={(event) => setOffset(Number(event.target.value) || 0)} /></label>
    </div>
    <div className="document-table"><table>
      <thead><tr><th>번호</th><th>제목</th><th>목차의 쪽</th><th>실제 PDF 쪽</th><th></th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.key}>
        <td><input aria-label={`${index + 1}번째 장 번호`} value={row.number} onChange={(event) => update(row.key, "number", event.target.value)} /></td>
        <td><input aria-label={`${index + 1}번째 장 제목`} value={row.title} onChange={(event) => update(row.key, "title", event.target.value)} />{problems[index] && <small>{problems[index]}</small>}</td>
        <td><input aria-label={`${index + 1}번째 장 목차의 쪽`} inputMode="numeric" value={row.page} onChange={(event) => update(row.key, "page", event.target.value)} /></td>
        <td>{Number.isInteger(starts[index]) ? `${starts[index]}~${ends[index]}` : "-"}</td>
        <td className="outline-actions">{Number.isInteger(starts[index]) && <a href={`${pdfUrl}#page=${starts[index]}`} target="_blank" rel="noreferrer">PDF 보기</a>}<button type="button" className="secondary" onClick={() => remove(row.key)} aria-label={`${index + 1}번째 장 삭제`}>삭제</button></td>
      </tr>)}</tbody>
    </table></div>
    <div className="actions">
      <button type="button" className="secondary" onClick={add}>+ 장 추가</button>
      <button type="button" disabled={busy || !valid} onClick={() => onConfirm(rows.map((row, index) => ({ number: row.number.trim(), title: row.title.trim(), pageFrom: starts[index] })))}>목차 확정 후 본문 처리</button>
      <button type="button" className="secondary" onClick={onClose}>나중에 하기</button>
    </div>
  </section>;
}
