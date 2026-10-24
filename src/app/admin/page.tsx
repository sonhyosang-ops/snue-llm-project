"use client";

// ─────────────────────────────────────────────────────────────────────────────
// admin/page.tsx — 관리자 화면 (주소: /admin)
//
// 할 수 있는 일
//   1) 허용 사용자 등록: 학교 메일을 역할(관리자 / 교장·교감 / 교사)과 함께 allowed_users에 추가한다.
//      이미 있는 메일을 다른 역할로 다시 등록하면 역할이 바뀐다.
//      CSV 파일(이메일, 역할 열)로 여러 명을 한꺼번에 등록할 수도 있다.
//   2) 문서 업로드 및 색인: PDF를 올리고(/api/admin/documents) 단계별로 색인한다(/api/admin/documents/[id]/ingest).
//      색인이 끝나도 바로 운영에 쓰이지 않고 "준비됨"이 된다.
//   3) 문서 목록: 준비된 문서를 "운영에 적용"하면 사용자 화면이 그 문서로 바뀐다(/api/admin/documents/[id]/activate).
//      개정판(예: 2027)에 문제가 있으면 이전 판(예: 2025)을 다시 적용해 바로 되돌릴 수 있다.
// 이 화면은 로그인한 관리자만 쓸 수 있다. 화면에서도 역할을 확인하지만,
// 진짜 보안은 서버 API의 requireAdmin(src/lib/auth.ts)이 맡는다(화면 확인은 우회될 수 있기 때문).
// ─────────────────────────────────────────────────────────────────────────────
import { FormEvent, useEffect, useState } from "react";
import { browserSupabase } from "@/lib/browser-supabase";
import { ROLE_LABELS, type Role } from "@/lib/types";
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
type DocumentRow = { id: string; title: string; year: string | null; status: string; error: string | null; is_active: boolean; created_at: string; processed_at: string | null; chapterCount: number };
type ChapterStep = { id: string; title: string };

// 문서 상태를 화면 이름으로 바꾼다. 운영 중(is_active)이 가장 먼저다.
function documentStatus(document: DocumentRow) {
  if (document.is_active) return "운영 중";
  return ({ ready: "준비됨", processing: "색인 중", failed: "실패", uploaded: "업로드됨" } as Record<string, string>)[document.status] ?? document.status;
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
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [progress, setProgress] = useState("");

  // 올린 문서 목록(상태·장 수)을 불러온다.
  const loadDocuments = async (accessToken: string) => {
    const body = await api("/api/admin/documents", accessToken) as { documents: DocumentRow[] };
    setDocuments(body.documents);
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

  // 문서 하나를 처음부터 끝까지 단계별로 색인한다(서버 시간 제한을 넘지 않도록 요청을 나눔).
  //   ① 목차 분석 → ② 장마다 본문(파싱·청크·임베딩) → ③ 장마다 핵심어 → ④ 마무리(준비됨)
  // 끝나도 운영에는 적용되지 않는다. 아래 문서 목록에서 확인한 뒤 "운영에 적용"을 눌러야 사용자 화면이 바뀐다.
  const runIngest = async (documentId: string) => {
    setProgress("목차를 분석하는 중입니다…");
    const { chapters } = await ingestStep(documentId, { step: "outline" }) as { chapters: ChapterStep[] };
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
    return chapters.length;
  };

  // PDF를 올린 뒤 바로 단계별 색인을 시작한다. 성공·실패와 관계없이 끝나면 문서 목록을 새로 불러온다.
  const uploadPdf = async (event: FormEvent) => {
    event.preventDefault();
    if (!pdf) return;
    setBusy(true); setMessage("");
    try {
      const form = new FormData(); form.set("file", pdf); form.set("title", title); form.set("year", year);
      const upload = await api("/api/admin/documents", token, { method: "POST", body: form }) as { id: string };
      await loadDocuments(token);
      const chapterCount = await runIngest(upload.id);
      setPdf(null);
      setMessage(`${chapterCount}개 장을 색인했습니다. 아래 문서 목록에서 확인한 뒤 "운영에 적용"을 누르면 사용자 화면이 새 문서로 바뀝니다.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "PDF 처리에 실패했습니다."); }
    finally { setBusy(false); setProgress(""); loadDocuments(token).catch(() => undefined); }
  };

  // 실패했거나 중간에 멈춘 문서를 처음 단계부터 다시 색인한다(올린 PDF는 그대로 다시 쓴다).
  const reindex = async (document: DocumentRow) => {
    setBusy(true); setMessage("");
    try {
      const chapterCount = await runIngest(document.id);
      setMessage(`'${document.title}' ${chapterCount}개 장을 다시 색인했습니다. 확인 후 "운영에 적용"을 누르세요.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "다시 색인하지 못했습니다."); }
    finally { setBusy(false); setProgress(""); loadDocuments(token).catch(() => undefined); }
  };

  // 문서를 운영에 적용한다. 새 판 적용과 이전 판으로 되돌리기가 같은 동작이다(활성 문서를 바꾸는 것).
  const activate = async (document: DocumentRow) => {
    if (!window.confirm(`'${document.title}'을(를) 운영에 적용할까요?\n모든 사용자의 화면과 검색이 이 문서로 바뀝니다.`)) return;
    setBusy(true); setMessage("");
    try {
      await api(`/api/admin/documents/${document.id}/activate`, token, { method: "POST" });
      setMessage(`'${document.title}'을(를) 운영에 적용했습니다.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "운영에 적용하지 못했습니다."); }
    finally { setBusy(false); loadDocuments(token).catch(() => undefined); }
  };

  // 로그인하지 않았으면 메인 화면에서 먼저 로그인하라고 안내한다.
  if (!token) return <main className="login-shell"><section className="login-card"><p className="eyebrow">관리자 페이지</p><h1>관리자 로그인이 필요합니다</h1><p>먼저 메인 화면에서 학교 이메일로 로그인한 뒤 이 페이지를 열어 주세요.</p><a className="text-button" href="/">메인 화면으로 이동</a>{message && <p className="notice">{message}</p>}</section></main>;

  // 관리자 화면 구성: 머리말 → 왼쪽 "허용 사용자" 등록·목록 / 오른쪽 "문서 업로드"
  return <main className="app-shell">
    <header><div><p className="eyebrow">관리자 전용</p><h1>문서와 사용자 관리</h1></div><div><a className="text-button" href="/">사용자 화면</a> <a className="text-button" href="/records">질문 기록</a> <button className="text-button" onClick={() => supabase.auth.signOut()}>로그아웃</button></div></header>
    {message && <p className="notice">{message}</p>}
    <section className="admin-panel"><div className="admin-grid"><div><h2>허용 사용자</h2><form onSubmit={addUser}><label>학교 이메일<input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teacher@baegotnuri.es.kr" required /></label><label>역할<select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)}>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label><button disabled={busy}>등록 · 역할 변경</button></form>{message && <p className="notice">{message}</p>}<ul className="user-list">{allowedUsers.map((allowedUser) => <li key={allowedUser.email}>{allowedUser.email} <span>{ROLE_LABELS[allowedUser.role] ?? allowedUser.role}</span></li>)}</ul><form className="csv-import" onSubmit={importCsv}><h3>CSV로 한꺼번에 등록</h3><p>첫 줄에 <strong>이메일, 역할</strong> 열이 있어야 하며 다른 열은 무시합니다. 역할은 관리자 / 교장·교감 / 교사 중 하나이고, 비우면 교사로 등록합니다. 파일에 없는 기존 사용자는 그대로 둡니다. <a href="/users-template.csv" download>양식 내려받기</a></p><label>CSV 파일<input type="file" accept=".csv,text/csv" onChange={(event) => { setCsvFile(event.target.files?.[0] ?? null); setImportResult(null); }} required /></label><button disabled={busy || !csvFile}>{busy ? "등록 중…" : "CSV 업로드"}</button></form>{importResult && <div className="import-result"><p><strong>새로 등록 {importResult.created}명 · 역할 갱신 {importResult.updated}명 · 건너뜀 {importResult.skipped.length}줄</strong></p>{importResult.notice && <p>{importResult.notice}</p>}{importResult.skipped.length > 0 && <ul>{importResult.skipped.map((row) => <li key={`${row.line}-${row.email}`}>{row.line}번째 줄 {row.email && `(${row.email}) `}— {row.reason}</li>)}</ul>}</div>}</div><div><h2>문서 업로드</h2><form onSubmit={uploadPdf}><label>문서 제목<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="문서 제목을 입력하세요" required /></label><label>판(연도)<input value={year} onChange={(event) => setYear(event.target.value)} placeholder="예: 2027" inputMode="numeric" required /></label><label>PDF 파일<input type="file" accept="application/pdf" onChange={(event) => setPdf(event.target.files?.[0] ?? null)} required /></label><button disabled={busy}>{busy ? "처리 중…" : "업로드 및 색인"}</button></form>{progress && <p className="notice">{progress} 이 창을 닫지 마세요.</p>}<p className="admin-hint">색인이 끝나도 바로 운영에 쓰이지 않습니다. 아래 문서 목록에서 확인한 뒤 "운영에 적용"을 누르세요. 이전 판은 남아 있어 언제든 다시 적용(되돌리기)할 수 있습니다.</p></div></div></section>
    <section className="admin-panel"><h2>문서 목록</h2><div className="document-table"><table><thead><tr><th>문서</th><th>상태</th><th>장</th><th>색인 완료</th><th>동작</th></tr></thead><tbody>{documents.map((document) => <tr key={document.id} className={document.is_active ? "active" : undefined}><td>{document.title}{document.year && <span> · {document.year}</span>}</td><td>{documentStatus(document)}{document.status === "failed" && document.error && <small>{document.error}</small>}</td><td>{document.chapterCount}</td><td>{document.processed_at ? new Date(document.processed_at).toLocaleDateString("ko-KR") : "-"}</td><td>{document.is_active ? "-" : document.status === "ready" ? <button type="button" disabled={busy} onClick={() => activate(document)}>운영에 적용</button> : <button type="button" className="secondary" disabled={busy} onClick={() => reindex(document)}>다시 색인</button>}</td></tr>)}</tbody></table></div></section>
  </main>;
}
