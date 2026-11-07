"use client";

// ─────────────────────────────────────────────────────────────────────────────
// admin/page.tsx — 관리자 화면 (주소: /admin)
//
// 할 수 있는 일
//   1) 허용 사용자 등록: 학교 메일을 역할(관리자 / 교장·교감 / 교사)과 함께 allowed_users에 추가한다.
//      이미 있는 메일을 다른 역할로 다시 등록하면 역할이 바뀐다.
//      CSV 파일(이메일, 역할 열)로 여러 명을 한꺼번에 등록할 수도 있다.
//   2) 문서 업로드 및 색인: 업무 매뉴얼을 고르거나(새 판) 새 매뉴얼을 만들어 PDF를 올린다(/api/admin/documents).
//      색인은 단계별로 진행된다(/api/admin/documents/[id]/ingest·/outline).
//        ① 목차 초안 → ② 관리자가 목차 확인·확정(outline-review.tsx) → ③ 장별 본문 → ④ 장별 핵심어 → ⑤ 마무리
//      색인이 끝나도 바로 운영에 쓰이지 않고 "준비됨"이 된다.
//   3) 문서 목록: 준비된 판을 "운영에 적용"하면 그 매뉴얼의 사용자 화면이 그 판으로 바뀐다(/activate).
//      개정판(예: 2027)에 문제가 있으면 이전 판(예: 2025)을 다시 적용해 바로 되돌릴 수 있다.
// 이 화면은 로그인한 관리자만 쓸 수 있다. 화면에서도 역할을 확인하지만,
// 진짜 보안은 서버 API의 requireAdmin(src/lib/auth.ts)이 맡는다(화면 확인은 우회될 수 있기 때문).
// ─────────────────────────────────────────────────────────────────────────────
import { FormEvent, useEffect, useState } from "react";
import OutlineReview from "@/app/admin/outline-review";
import { browserSupabase } from "@/lib/browser-supabase";
import { ROLE_LABELS, type ConfirmedChapter, type OutlineDraft, type Role } from "@/lib/types";
import type { SkippedRow } from "@/lib/user-csv";

// CSV 파일을 글자로 읽는다. 엑셀에서 "CSV(쉼표로 분리)"로 저장하면 한글이 UTF-8이 아니라 EUC-KR(CP949)로 저장된다.
// 그래서 먼저 UTF-8로 엄격하게(fatal) 읽어 보고, 깨진 글자가 있어 실패하면 EUC-KR로 다시 읽는다.
async function readCsvText(file: File) {
  const bytes = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("euc-kr").decode(bytes); }
}

// CSV 일괄 등록 결과(/api/admin/users/import 응답)
type ImportResult = { created: number; updated: number; skipped: SkippedRow[]; notice: string };

// 문서 목록 한 줄(/api/admin/documents GET 응답)
type DocumentRow = {
  id: string; title: string; year: string | null; status: string; error: string | null; is_active: boolean;
  created_at: string; processed_at: string | null; chapterCount: number; manual: { id: string; title: string } | null;
};
type Manual = { id: string; title: string };
type ChapterStep = { id: string; title: string };
// 목차 확인 표에 넘길 내용(/api/admin/documents/[id]/outline GET 응답 + 문서 id)
type Review = { documentId: string; title: string; pageCount: number; draft: OutlineDraft; pdfUrl: string };

// 업로드 폼의 매뉴얼 선택 값 중 "새 매뉴얼 만들기"를 뜻하는 특별한 값
const NEW_MANUAL = "__new__";

// 문서 상태를 화면 이름으로 바꾼다. 운영 중(is_active)이 가장 먼저다.
function documentStatus(document: DocumentRow) {
  if (document.is_active) return "운영 중";
  return ({ ready: "준비됨", review: "목차 확인 대기", processing: "색인 중", failed: "실패", uploaded: "업로드됨" } as Record<string, string>)[document.status] ?? document.status;
}

// 서버 API 호출 도우미(사용자 화면 page.tsx와 같은 방식). 토큰을 붙여 보내고 실패하면 서버 메시지로 오류를 낸다.
async function api(path: string, token: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "요청을 처리하지 못했습니다.");
  return body;
}

export default function AdminPage() {
  const [supabase] = useState(browserSupabase);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>("user");
  const [allowedUsers, setAllowedUsers] = useState<{ email: string; role: Role }[]>([]);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [manualChoice, setManualChoice] = useState("");
  const [newManualTitle, setNewManualTitle] = useState("");
  const [manuals, setManuals] = useState<Manual[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [progress, setProgress] = useState("");
  const [review, setReview] = useState<Review | null>(null);

  // 매뉴얼 목록과 올린 문서 목록(상태·장 수)을 불러온다.
  const loadDocuments = async (accessToken: string) => {
    const body = await api("/api/admin/documents", accessToken) as { documents: DocumentRow[]; manuals: Manual[] };
    setDocuments(body.documents);
    setManuals(body.manuals);
    setManualChoice((current) => current || body.manuals[0]?.id || NEW_MANUAL);
  };

  // 관리자인지 확인한 뒤 허용 사용자 목록과 문서 목록을 불러온다. 역할은 /api/chapters 응답의 role로 확인한다.
  const loadAdmin = async (accessToken: string) => {
    const workspace = await api("/api/chapters", accessToken) as { role: Role };
    if (workspace.role !== "admin") throw new Error("관리자만 사용할 수 있습니다.");
    const users = await api("/api/admin/users", accessToken) as { users: { email: string; role: Role }[] };
    setAllowedUsers(users.users);
    await loadDocuments(accessToken);
  };

  // 화면이 열릴 때 현재 로그인 세션을 읽고, 이후 로그인 상태가 바뀔 때마다 다시 불러온다.
  // 관리자 화면에는 로그인 기능이 없다. 메인 화면에서 로그인한 세션을 같은 브라우저에서 이어 쓴다.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const accessToken = data.session?.access_token ?? "";
      setToken(accessToken);
      if (accessToken) loadAdmin(accessToken).catch((error: Error) => setMessage(error.message));
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const accessToken = session?.access_token ?? "";
      setToken(accessToken);
      if (accessToken) loadAdmin(accessToken).catch((error: Error) => setMessage(error.message));
      else setAllowedUsers([]);
    });
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  // 허용 사용자를 고른 역할로 등록(또는 역할 변경)한 뒤 목록을 다시 불러온다.
  const addUser = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      await api("/api/admin/users", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: newUserEmail, role: newUserRole }) });
      setNewUserEmail(""); setNewUserRole("user");
      await loadAdmin(token);
      setMessage("허용 사용자가 등록되었습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "사용자 등록에 실패했습니다."); }
    finally { setBusy(false); }
  };

  // CSV 명단을 읽어 서버에 보내고, 결과(새로 등록·역할 갱신·건너뛴 줄)를 보여 준 뒤 목록을 다시 불러온다.
  // 메일·역할 검사는 서버가 한다(src/lib/user-csv.ts). 화면은 파일을 글자로 바꿔 보내기만 한다.
  const importCsv = async (event: FormEvent) => {
    event.preventDefault();
    if (!csvFile) return;
    setBusy(true); setMessage(""); setImportResult(null);
    try {
      const csv = await readCsvText(csvFile);
      const result = await api("/api/admin/users/import", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv }) }) as ImportResult;
      setImportResult(result);
      await loadAdmin(token);
    } catch (error) { setMessage(error instanceof Error ? error.message : "CSV 등록에 실패했습니다."); }
    finally { setBusy(false); }
  };

  // 색인 단계 하나를 호출한다. 파싱·임베딩 서버의 일시적인 오류(요청 한도, 서버 바쁨)는 잠시 뒤 다시 하면
  // 풀리는 경우가 많으므로, 실패하면 5초 쉬고 최대 2번 더 시도한다. 각 단계는 다시 실행해도 안전하게 만들어져 있다.
  const ingestStep = async (documentId: string, body: { step: string; chapterId?: string }) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await api(`/api/admin/documents/${documentId}/ingest`, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  // 목차 확인 표를 연다: 서버에서 초안·PDF 쪽수·PDF 임시 주소를 받아 온다.
  const openReview = async (documentId: string) => {
    const body = await api(`/api/admin/documents/${documentId}/outline`, token) as Omit<Review, "documentId">;
    setReview({ ...body, documentId });
  };

  // [① 목차 초안] PDF 앞부분을 분석해 초안을 만든 뒤, 관리자가 확인할 수 있도록 목차 확인 표를 연다.
  const startOutline = async (documentId: string) => {
    setProgress("목차를 분석하는 중입니다…");
    await ingestStep(documentId, { step: "outline" });
    setProgress("");
    await openReview(documentId);
    setMessage("목차 초안을 만들었습니다. 아래 목차 확인 표에서 장을 확인한 뒤 확정하세요.");
  };

  // [③~⑤] 확정된 장으로 본문·핵심어·마무리를 차례로 실행한다(서버 시간 제한을 넘지 않도록 장마다 요청을 나눔).
  // 끝나도 운영에는 적용되지 않는다. 문서 목록에서 확인한 뒤 "운영에 적용"을 눌러야 사용자 화면이 바뀐다.
  const runBody = async (documentId: string, chapters: ChapterStep[]) => {
    for (const [index, chapter] of chapters.entries()) {
      setProgress(`본문을 처리하는 중입니다 (${index + 1}/${chapters.length}장 · ${chapter.title})…`);
      await ingestStep(documentId, { step: "chapter", chapterId: chapter.id });
    }
    for (const [index, chapter] of chapters.entries()) {
      setProgress(`핵심어 사전을 만드는 중입니다 (${index + 1}/${chapters.length}장 · ${chapter.title})…`);
      await ingestStep(documentId, { step: "keywords", chapterId: chapter.id });
    }
    setProgress("마무리 확인 중입니다…");
    await ingestStep(documentId, { step: "finish" });
    setMessage(`${chapters.length}개 장을 색인했습니다. 문서 목록에서 확인한 뒤 "운영에 적용"을 누르면 사용자 화면이 새 판으로 바뀝니다.`);
  };

  // 작업 하나(업로드·목차 분석·본문 처리 등)를 잠금·오류 안내·목록 새로고침과 함께 실행하는 공통 틀
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await work(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "처리하지 못했습니다."); }
    finally { setBusy(false); setProgress(""); loadDocuments(token).catch(() => undefined); }
  };

  // PDF를 올린 뒤 바로 목차 초안까지 만든다. 장 확정과 본문 처리는 관리자가 목차를 확인한 다음에 한다.
  const uploadPdf = (event: FormEvent) => {
    event.preventDefault();
    if (!pdf) return;
    run(async () => {
      const form = new FormData();
      form.set("file", pdf); form.set("title", title); form.set("year", year);
      if (manualChoice === NEW_MANUAL) form.set("newManualTitle", newManualTitle); else form.set("manualId", manualChoice);
      const upload = await api("/api/admin/documents", token, { method: "POST", body: form }) as { id: string };
      setPdf(null);
      await loadDocuments(token);
      await startOutline(upload.id);
    });
  };

  // [② 목차 확정] 관리자가 확인한 장 목록을 저장하고, 이어서 본문 처리를 시작한다.
  const confirmOutline = (chapters: ConfirmedChapter[]) => {
    if (!review) return;
    const documentId = review.documentId;
    run(async () => {
      const body = await api(`/api/admin/documents/${documentId}/outline`, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapters }) }) as { chapters: ChapterStep[] };
      setReview(null);
      await runBody(documentId, body.chapters);
    });
  };

  // 실패했거나 중간에 멈춘 문서를 이어서 처리한다. 장이 이미 확정되어 있으면 본문부터, 없으면 목차 초안부터 다시 한다.
  const resume = (document: DocumentRow) => run(async () => {
    if (!document.chapterCount) return startOutline(document.id);
    const body = await api(`/api/admin/documents/${document.id}/outline`, token) as { chapters: ChapterStep[] };
    await runBody(document.id, body.chapters);
  });

  // 판을 운영에 적용한다. 새 판 적용과 이전 판으로 되돌리기가 같은 동작이다(그 매뉴얼의 운영 판을 바꾸는 것).
  const activate = (document: DocumentRow) => {
    if (!window.confirm(`'${document.title}'을(를) 운영에 적용할까요?\n'${document.manual?.title ?? "이 매뉴얼"}'을(를) 보는 모든 사용자의 화면과 검색이 이 판으로 바뀝니다.`)) return;
    run(async () => {
      await api(`/api/admin/documents/${document.id}/activate`, token, { method: "POST" });
      setMessage(`'${document.title}'을(를) 운영에 적용했습니다.`);
    });
  };

  // 문서 목록의 "동작" 칸: 상태에 따라 할 수 있는 일이 다르다.
  const actionFor = (document: DocumentRow) => {
    if (document.is_active) return "-";
    if (document.status === "ready") return <button type="button" disabled={busy} onClick={() => activate(document)}>운영에 적용</button>;
    if (document.status === "review") return <button type="button" disabled={busy} onClick={() => run(() => openReview(document.id))}>목차 확인</button>;
    return <span className="row-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => resume(document)}>{document.chapterCount ? "이어서 처리" : "목차 분석"}</button>
      {document.chapterCount > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => startOutline(document.id))}>목차부터 다시</button>}
    </span>;
  };

  // 로그인하지 않았으면 메인 화면에서 먼저 로그인하라고 안내한다.
  if (!token) return <main className="login-shell"><section className="login-card"><p className="eyebrow">관리자 페이지</p><h1>관리자 로그인이 필요합니다</h1><p>먼저 메인 화면에서 학교 이메일로 로그인한 뒤 이 페이지를 열어 주세요.</p><a className="text-button" href="/">메인 화면으로 이동</a>{message && <p className="notice">{message}</p>}</section></main>;

  // 관리자 화면 구성: 머리말 → 왼쪽 "허용 사용자" 등록·목록 / 오른쪽 "문서 업로드" → (목차 확인 표) → 문서 목록
  return <main className="app-shell">
    <header><div><p className="eyebrow">관리자 전용</p><h1>문서와 사용자 관리</h1></div><div><a className="text-button" href="/">사용자 화면</a> <a className="text-button" href="/records">질문 기록</a> <button className="text-button" onClick={() => supabase.auth.signOut()}>로그아웃</button></div></header>
    {message && <p className="notice">{message}</p>}
    {progress && <p className="notice">{progress} 이 창을 닫지 마세요.</p>}
    <section className="admin-panel"><div className="admin-grid"><div><h2>허용 사용자</h2><form onSubmit={addUser}><label>학교 이메일<input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teacher@baegotnuri.es.kr" required /></label><label>역할<select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)}>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label><button disabled={busy}>등록 · 역할 변경</button></form><ul className="user-list">{allowedUsers.map((allowedUser) => <li key={allowedUser.email}>{allowedUser.email} <span>{ROLE_LABELS[allowedUser.role] ?? allowedUser.role}</span></li>)}</ul><form className="csv-import" onSubmit={importCsv}><h3>CSV로 한꺼번에 등록</h3><p>첫 줄에 <strong>이메일, 역할</strong> 열이 있어야 하며 다른 열은 무시합니다. 역할은 관리자 / 교장·교감 / 교사 중 하나이고, 비우면 교사로 등록합니다. 파일에 없는 기존 사용자는 그대로 둡니다. <a href="/users-template.csv" download>양식 내려받기</a></p><label>CSV 파일<input type="file" accept=".csv,text/csv" onChange={(event) => { setCsvFile(event.target.files?.[0] ?? null); setImportResult(null); }} required /></label><button disabled={busy || !csvFile}>{busy ? "등록 중…" : "CSV 업로드"}</button></form>{importResult && <div className="import-result"><p><strong>새로 등록 {importResult.created}명 · 역할 갱신 {importResult.updated}명 · 건너뜀 {importResult.skipped.length}줄</strong></p>{importResult.notice && <p>{importResult.notice}</p>}{importResult.skipped.length > 0 && <ul>{importResult.skipped.map((row) => <li key={`${row.line}-${row.email}`}>{row.line}번째 줄 {row.email && `(${row.email}) `}— {row.reason}</li>)}</ul>}</div>}</div>
      <div><h2>문서 업로드</h2><form onSubmit={uploadPdf}><label>업무 매뉴얼<select value={manualChoice} onChange={(event) => setManualChoice(event.target.value)}>{manuals.map((manual) => <option key={manual.id} value={manual.id}>{manual.title} (새 판)</option>)}<option value={NEW_MANUAL}>+ 새 매뉴얼 추가</option></select></label>{manualChoice === NEW_MANUAL && <label>새 매뉴얼 이름<input value={newManualTitle} onChange={(event) => setNewManualTitle(event.target.value)} placeholder="예: 학교회계 업무 매뉴얼" required /></label>}<label>문서 제목<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="문서 제목을 입력하세요" required /></label><label>판(연도)<input value={year} onChange={(event) => setYear(event.target.value)} placeholder="예: 2027" inputMode="numeric" required /></label><label>PDF 파일<input type="file" accept="application/pdf" onChange={(event) => setPdf(event.target.files?.[0] ?? null)} required /></label><button disabled={busy}>{busy ? "처리 중…" : "업로드 및 목차 분석"}</button></form><p className="admin-hint">올리면 먼저 목차 초안을 만들고, 관리자가 장을 확인·확정한 뒤 본문을 처리합니다. 색인이 끝나도 바로 운영에 쓰이지 않으며, 문서 목록에서 "운영에 적용"을 눌러야 합니다. 이전 판은 남아 있어 언제든 다시 적용(되돌리기)할 수 있습니다.</p></div></div></section>
    {review && <OutlineReview key={review.documentId} title={review.title} pageCount={review.pageCount} draft={review.draft} pdfUrl={review.pdfUrl} busy={busy} onConfirm={confirmOutline} onClose={() => setReview(null)} />}
    <section className="admin-panel"><h2>문서 목록</h2><div className="document-table"><table><thead><tr><th>매뉴얼</th><th>문서</th><th>상태</th><th>장</th><th>색인 완료</th><th>동작</th></tr></thead><tbody>{documents.map((document) => <tr key={document.id} className={document.is_active ? "active" : undefined}><td>{document.manual?.title ?? "-"}</td><td>{document.title}{document.year && <span> · {document.year}</span>}</td><td>{documentStatus(document)}{document.status === "failed" && document.error && <small>{document.error}</small>}</td><td>{document.chapterCount}</td><td>{document.processed_at ? new Date(document.processed_at).toLocaleDateString("ko-KR") : "-"}</td><td>{actionFor(document)}</td></tr>)}</tbody></table></div></section>
  </main>;
}
