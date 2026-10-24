"use client";

// ─────────────────────────────────────────────────────────────────────────────
// admin/page.tsx — 관리자 화면 (주소: /admin)
//
// 할 수 있는 일
//   1) 허용 사용자 등록: 학교 메일을 역할(관리자 / 교장·교감 / 교사)과 함께 allowed_users에 추가한다.
//      이미 있는 메일을 다른 역할로 다시 등록하면 역할이 바뀐다.
//      CSV 파일(이메일, 역할 열)로 여러 명을 한꺼번에 등록할 수도 있다.
//   2) 문서 업로드 및 색인: PDF를 올리고(/api/admin/documents) 바로 색인한다(/api/admin/documents/[id]/ingest).
//      색인이 끝나면 새 문서가 활성 문서가 되어 사용자 화면에 나타난다.
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

  // 관리자인지 확인한 뒤 허용 사용자 목록을 불러온다. 역할은 /api/chapters 응답의 role로 확인한다.
  const loadAdmin = async (accessToken: string) => {
    const workspace = await api("/api/chapters", accessToken) as { role: Role };
    if (workspace.role !== "admin") throw new Error("관리자만 사용할 수 있습니다.");
    const users = await api("/api/admin/users", accessToken) as { users: { email: string; role: Role }[] };
    setAllowedUsers(users.users);
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

  // PDF 업로드와 색인을 차례로 실행한다.
  //   ① /api/admin/documents        : 파일 저장 → 문서 id 받기
  //   ② /api/admin/documents/{id}/ingest : 파싱·장 분리·청크·임베딩·핵심어 사전 만들기(수 분 걸릴 수 있음)
  const uploadPdf = async (event: FormEvent) => {
    event.preventDefault();
    if (!pdf) return;
    setBusy(true); setMessage("PDF를 올리고 색인하는 중입니다. 문서 크기에 따라 몇 분 걸릴 수 있습니다.");
    try {
      const form = new FormData(); form.set("file", pdf); form.set("title", title); form.set("year", "2025");
      const upload = await api("/api/admin/documents", token, { method: "POST", body: form }) as { id: string };
      const ingest = await api(`/api/admin/documents/${upload.id}/ingest`, token, { method: "POST" }) as { chapterCount: number };
      setPdf(null); setMessage(`${ingest.chapterCount}개 장을 색인했습니다.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "PDF 처리에 실패했습니다."); }
    finally { setBusy(false); }
  };

  // 로그인하지 않았으면 메인 화면에서 먼저 로그인하라고 안내한다.
  if (!token) return <main className="login-shell"><section className="login-card"><p className="eyebrow">관리자 페이지</p><h1>관리자 로그인이 필요합니다</h1><p>먼저 메인 화면에서 학교 이메일로 로그인한 뒤 이 페이지를 열어 주세요.</p><a className="text-button" href="/">메인 화면으로 이동</a>{message && <p className="notice">{message}</p>}</section></main>;

  // 관리자 화면 구성: 머리말 → 왼쪽 "허용 사용자" 등록·목록 / 오른쪽 "문서 업로드"
  return <main className="app-shell">
    <header><div><p className="eyebrow">관리자 전용</p><h1>문서와 사용자 관리</h1></div><div><a className="text-button" href="/">사용자 화면</a> <a className="text-button" href="/records">질문 기록</a> <button className="text-button" onClick={() => supabase.auth.signOut()}>로그아웃</button></div></header>
    {message && <p className="notice">{message}</p>}
    <section className="admin-panel"><div className="admin-grid"><div><h2>허용 사용자</h2><form onSubmit={addUser}><label>학교 이메일<input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teacher@baegotnuri.es.kr" required /></label><label>역할<select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)}>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label><button disabled={busy}>등록 · 역할 변경</button></form>{message && <p className="notice">{message}</p>}<ul className="user-list">{allowedUsers.map((allowedUser) => <li key={allowedUser.email}>{allowedUser.email} <span>{ROLE_LABELS[allowedUser.role] ?? allowedUser.role}</span></li>)}</ul><form className="csv-import" onSubmit={importCsv}><h3>CSV로 한꺼번에 등록</h3><p>첫 줄에 <strong>이메일, 역할</strong> 열이 있어야 하며 다른 열은 무시합니다. 역할은 관리자 / 교장·교감 / 교사 중 하나이고, 비우면 교사로 등록합니다. 파일에 없는 기존 사용자는 그대로 둡니다. <a href="/users-template.csv" download>양식 내려받기</a></p><label>CSV 파일<input type="file" accept=".csv,text/csv" onChange={(event) => { setCsvFile(event.target.files?.[0] ?? null); setImportResult(null); }} required /></label><button disabled={busy || !csvFile}>{busy ? "등록 중…" : "CSV 업로드"}</button></form>{importResult && <div className="import-result"><p><strong>새로 등록 {importResult.created}명 · 역할 갱신 {importResult.updated}명 · 건너뜀 {importResult.skipped.length}줄</strong></p>{importResult.notice && <p>{importResult.notice}</p>}{importResult.skipped.length > 0 && <ul>{importResult.skipped.map((row) => <li key={`${row.line}-${row.email}`}>{row.line}번째 줄 {row.email && `(${row.email}) `}— {row.reason}</li>)}</ul>}</div>}</div><div><h2>문서 업로드</h2><form onSubmit={uploadPdf}><label>문서 제목<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="문서 제목을 입력하세요" required /></label><label>PDF 파일<input type="file" accept="application/pdf" onChange={(event) => setPdf(event.target.files?.[0] ?? null)} required /></label><button disabled={busy}>{busy ? "처리 중…" : "업로드 및 색인"}</button></form></div></div></section>
  </main>;
}
