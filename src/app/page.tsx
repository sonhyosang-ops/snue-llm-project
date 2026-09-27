"use client";

import { FormEvent, useEffect, useState } from "react";
import { browserSupabase } from "@/lib/browser-supabase";
import type { AskResult, Chapter, Role } from "@/lib/types";

type Workspace = {
  role: Role;
  document: { id: string; title: string; year: string | null } | null;
  chapters: Chapter[];
};

async function api(path: string, token: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "요청을 처리하지 못했습니다.");
  return body;
}

export default function Home() {
  const [supabase] = useState(browserSupabase);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const loadWorkspace = async (accessToken: string) => {
    const next = await api("/api/chapters", accessToken) as Workspace;
    setWorkspace(next);
    setChapter((current) => next.chapters.find((item) => item.id === current?.id) ?? next.chapters[0] ?? null);
  };

  useEffect(() => {
    const loadSession = () => supabase.auth.getSession().then(({ data }) => {
      const accessToken = data.session?.access_token;
      if (accessToken) {
        setToken(accessToken);
        loadWorkspace(accessToken).catch((error: Error) => setMessage(error.message));
      }
    });
    loadSession();
    const timer = window.setInterval(() => {
      loadSession().then(() => {
        if (localStorage.getItem("baegotnuri-login-complete")) window.clearInterval(timer);
      });
    }, 1500);
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const accessToken = session?.access_token ?? "";
      setToken(accessToken);
      if (accessToken) loadWorkspace(accessToken).catch((error: Error) => setMessage(error.message));
      else { setWorkspace(null); setChapter(null); }
    });
    return () => { window.clearInterval(timer); listener.subscription.unsubscribe(); };
  }, [supabase]);

  const requestLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      localStorage.removeItem("baegotnuri-login-complete");
      const response = await fetch("/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setMessage("로그인 링크를 이메일로 보냈습니다. 링크를 클릭한 뒤, 이 창으로 돌아오면 자동으로 로그인됩니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "로그인 요청에 실패했습니다."); }
    finally { setBusy(false); }
  };

  const ask = async (approvedChapterId?: string) => {
    if (!chapter || !question.trim()) return;
    setBusy(true); setAnswer(null); setMessage("");
    try {
      const result = await api("/api/ask", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapterId: chapter.id, question, approvedChapterId }) }) as AskResult;
      setAnswer(result);
    } catch (error) { setMessage(error instanceof Error ? error.message : "답변을 만들지 못했습니다."); }
    finally { setBusy(false); }
  };

  if (!token) {
    return <main className="login-shell"><section className="login-card"><p className="eyebrow">배곧누리초등학교</p><h1>교육공무원<br />인사실무편람</h1><p>등록된 교직원만 이용할 수 있습니다.</p><form onSubmit={requestLogin}><label>학교 이메일<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@baegotnuri.es.kr" required /></label><button disabled={busy}>{busy ? "보내는 중…" : "로그인 링크 받기"}</button></form>{message && <p className="notice">{message}</p>}</section></main>;
  }

  return <main className="app-shell">
    <header><div><p className="eyebrow">근거 기반 안내</p><h1>교육공무원 인사실무편람</h1></div><button className="text-button" onClick={() => { localStorage.removeItem("baegotnuri-login-complete"); supabase.auth.signOut(); }}>로그아웃</button></header>
    {message && <p className="notice">{message}</p>}
    {workspace?.role === "admin" && <p><a className="text-button" href="/admin">관리자 페이지 열기</a></p>}
    <section className="workspace"><div className="document-title"><p className="eyebrow">현재 문서</p><h2>{workspace?.document?.title ?? "아직 활성화된 문서가 없습니다."}</h2></div><div className="chapter-list">{workspace?.chapters.map((item) => <button key={item.id} className={chapter?.id === item.id ? "chapter active" : "chapter"} onClick={() => { setChapter(item); setAnswer(null); }}>{item.chapter_number && `${item.chapter_number} `}{item.title}</button>)}</div>
      {chapter && <section className="question-card"><p className="eyebrow">선택한 범위 · {chapter.title} · {chapter.page_from}~{chapter.page_to}쪽</p><h2>무엇이 궁금하신가요?</h2><textarea aria-label="질문 입력" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="예: 승진후보자명부는 어떤 기준으로 작성하나요?" rows={4} /><button onClick={() => ask()} disabled={busy || !question.trim()}>{busy ? "근거를 찾는 중…" : "질문하기"}</button></section>}
      {answer?.type === "suggestion" && <section className="result-card suggestion"><h2>다른 장을 확인해 볼까요?</h2><p>질문의 핵심어 “{answer.keywords.join(", ") || "관련 내용"}”가 <strong>{answer.chapter.chapter_number} {answer.chapter.title}</strong>에 포함된 것으로 보입니다.</p><div className="actions"><button disabled={busy} onClick={() => ask(answer.chapter.id)}>해당 장에서 답변받기</button><button className="secondary" onClick={() => setAnswer(null)}>현재 장 유지</button></div></section>}
      {answer?.type === "not_found" && <section className="result-card"><h2>확인할 수 없습니다</h2><p>{answer.message}</p></section>}
      {answer?.type === "answer" && <section className="result-card"><p className="eyebrow">답변 · 핵심어 {answer.keywords.join(", ") || "없음"}</p><h2>안내</h2><p className="answer-text">{answer.answer}</p><h3>확인한 근거</h3><ul className="citation-list">{answer.citations.map((citation, index) => <li key={citation.chunkId}><strong>[{index + 1}] {citation.heading || chapter?.title}</strong> · {citation.pageFrom}~{citation.pageTo}쪽<p>{citation.excerpt}</p></li>)}</ul></section>}
    </section>
  </main>;
}
