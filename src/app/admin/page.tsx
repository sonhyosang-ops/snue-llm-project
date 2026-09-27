"use client";

import { FormEvent, useEffect, useState } from "react";
import { browserSupabase } from "@/lib/browser-supabase";
import type { Role } from "@/lib/types";

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
  const [allowedUsers, setAllowedUsers] = useState<{ email: string; role: Role }[]>([]);
  const [pdf, setPdf] = useState<File | null>(null);
  const [title, setTitle] = useState("");

  const loadAdmin = async (accessToken: string) => {
    const workspace = await api("/api/chapters", accessToken) as { role: Role };
    if (workspace.role !== "admin") throw new Error("관리자만 사용할 수 있습니다.");
    const users = await api("/api/admin/users", accessToken) as { users: { email: string; role: Role }[] };
    setAllowedUsers(users.users);
  };

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

  const addUser = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      await api("/api/admin/users", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: newUserEmail }) });
      setNewUserEmail("");
      await loadAdmin(token);
      setMessage("허용 사용자가 등록되었습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "사용자 등록에 실패했습니다."); }
    finally { setBusy(false); }
  };

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

  if (!token) return <main className="login-shell"><section className="login-card"><p className="eyebrow">관리자 페이지</p><h1>관리자 로그인이 필요합니다</h1><p>먼저 메인 화면에서 학교 이메일로 로그인한 뒤 이 페이지를 열어 주세요.</p><a className="text-button" href="/">메인 화면으로 이동</a>{message && <p className="notice">{message}</p>}</section></main>;

  return <main className="app-shell">
    <header><div><p className="eyebrow">관리자 전용</p><h1>문서와 사용자 관리</h1></div><div><a className="text-button" href="/">사용자 화면</a> <button className="text-button" onClick={() => supabase.auth.signOut()}>로그아웃</button></div></header>
    {message && <p className="notice">{message}</p>}
    <section className="admin-panel"><div className="admin-grid"><div><h2>허용 사용자</h2><form onSubmit={addUser}><label>학교 이메일<input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teacher@baegotnuri.es.kr" required /></label><button disabled={busy}>사용자 등록</button></form>{message && <p className="notice">{message}</p>}<ul className="user-list">{allowedUsers.map((allowedUser) => <li key={allowedUser.email}>{allowedUser.email} <span>{allowedUser.role === "admin" ? "관리자" : "사용자"}</span></li>)}</ul></div><div><h2>문서 업로드</h2><form onSubmit={uploadPdf}><label>문서 제목<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="문서 제목을 입력하세요" required /></label><label>PDF 파일<input type="file" accept="application/pdf" onChange={(event) => setPdf(event.target.files?.[0] ?? null)} required /></label><button disabled={busy}>{busy ? "처리 중…" : "업로드 및 색인"}</button></form></div></div></section>
  </main>;
}
