"use client";

// ─────────────────────────────────────────────────────────────────────────────
// records/page.tsx — 전체 질문 기록 검색 화면 (주소: /records, 관리자·교장·교감 전용)
//
// 모든 교직원의 질문과 답변을 최신순으로 보고 검색한다. 자주 묻는 질문 파악, 답변 품질 점검에 쓴다.
// 역할에 따라 보이는 정보가 다르며, 그 구분은 화면이 아니라 서버(/api/records)가 한다.
//   - 관리자     : 질문자 메일과 날짜·시각까지 보이고, 질문자 메일로도 검색된다.
//   - 교장·교감  : 질문자는 서버가 보내지 않으므로 보이지 않고, 날짜만 보인다.
//   - 교사       : 서버가 거절하므로 안내 문구만 보인다.
// 로그인은 메인 화면에서 한 세션을 같은 브라우저에서 이어 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
import { FormEvent, useEffect, useState } from "react";
import { browserSupabase } from "@/lib/browser-supabase";
import type { RecordItem } from "@/lib/types";

export default function RecordsPage() {
  // 화면 상태: token(로그인 토큰), keyword(검색어), records(검색 결과),
  // showsQuestioner(서버가 질문자를 보내 주는 역할인지), message(안내·오류 문구), busy(검색 중 여부)
  const [supabase] = useState(browserSupabase);
  const [token, setToken] = useState("");
  const [keyword, setKeyword] = useState("");
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [showsQuestioner, setShowsQuestioner] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // 서버에서 기록을 검색한다. 검색어가 비어 있으면 최신 50건을 받는다.
  const search = async (accessToken: string, query: string) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/records?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "기록을 불러오지 못했습니다.");
      setRecords(body.records);
      setShowsQuestioner(body.showsQuestioner);
    } catch (error) { setRecords([]); setMessage(error instanceof Error ? error.message : "기록을 불러오지 못했습니다."); }
    finally { setBusy(false); }
  };

  // 화면이 열리면 현재 로그인 세션을 읽고, 최신 기록을 한 번 불러온다.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const accessToken = data.session?.access_token ?? "";
      setToken(accessToken);
      if (accessToken) search(accessToken, "");
    });
  }, [supabase]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    search(token, keyword);
  };

  // 로그인하지 않았으면 메인 화면에서 먼저 로그인하라고 안내한다.
  if (!token) return <main className="login-shell"><section className="login-card"><p className="eyebrow">질문 기록</p><h1>로그인이 필요합니다</h1><p>먼저 메인 화면에서 학교 이메일로 로그인한 뒤 이 페이지를 열어 주세요.</p><a className="text-button" href="/">메인 화면으로 이동</a></section></main>;

  // 화면 구성: 머리말 → 개인정보 안내 → 검색창 → 결과 목록(펼치면 답변 전체)
  return <main className="app-shell">
    <header><div><p className="eyebrow">관리자 · 교장·교감 전용</p><h1>전체 질문 기록</h1></div><div><a className="text-button" href="/">사용자 화면</a></div></header>
    <p className="notice">{showsQuestioner ? "관리자 화면입니다. 질문자와 질문 시각까지 표시되며, 질문자 메일로도 검색할 수 있습니다." : "개인정보 보호를 위해 질문자와 질문 시각은 표시되지 않습니다. 질문과 답변 내용만 볼 수 있습니다."}</p>
    <form className="records-search" onSubmit={submit}><label>검색어<input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={showsQuestioner ? "질문·답변 내용 또는 질문자 메일" : "질문·답변 내용"} /></label><button disabled={busy}>{busy ? "찾는 중…" : "검색"}</button></form>
    {message && <p className="notice">{message}</p>}
    <p className="records-count">{records.length}건{records.length === 50 ? " (최신 50건까지 표시)" : ""}</p>
    <ul className="record-list">{records.map((record) => <li key={record.id}><details><summary><span className="record-meta">{record.date}{record.chapter ? ` · ${record.chapter.chapter_number}장 ${record.chapter.title}` : ""}{record.questioner ? ` · ${record.questioner}` : ""}</span><span className="record-question">{record.question}</span></summary><p className="answer-text">{record.answer}</p></details></li>)}</ul>
  </main>;
}
