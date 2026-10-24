"use client";

// ─────────────────────────────────────────────────────────────────────────────
// page.tsx — 사용자 메인 화면 (주소: /)
//
// 화면 흐름: 로그인 전 → 메일 입력해 로그인 링크 받기
//            로그인 후 → 3단 작업대 화면(C안)
//              왼쪽  : 문서 제목, 장 목록(검색 범위 선택), 최근 질문(내 기록 다시 보기),
//                      전체 질문 기록(관리자·교장·교감), 관리자 페이지(관리자), 로그아웃
//              가운데: 선택한 장, 질문 입력, 결과(답변 / 다른 장 제안 / 찾지 못함)
//              오른쪽: 확인한 근거(답변 속 [1]을 누르면 해당 근거가 강조된다)
// "use client": 이 화면은 브라우저에서 실행되는 컴포넌트다(입력·클릭 같은 상호작용이 필요하기 때문).
// 데이터는 모두 서버 API(/api/chapters, /api/ask, /api/messages)를 통해 받는다. 브라우저는 DB에 직접 접근하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { browserSupabase } from "@/lib/browser-supabase";
import type { AskResult, Chapter, HistoryItem, Role } from "@/lib/types";

// "확인한 근거" 원문을 마크다운으로 그린다. remark-gfm은 표(| a | b |)와 같은 GitHub식 마크다운 문법을 켠다.
// react-markdown은 원문 속 HTML 태그를 실행하지 않고 글자로만 다루므로, 근거에 이상한 태그가 섞여도 안전하다.
// 원문의 "# 사례 7" 같은 제목은 화면 제목처럼 크게 보이면 어색하므로 굵은 글씨 한 줄로 바꿔 그린다.
const sourceHeading: Components["h1"] = ({ children }) => <p className="source-heading"><strong>{children}</strong></p>;
const SOURCE_MARKDOWN: Components = { h1: sourceHeading, h2: sourceHeading, h3: sourceHeading, h4: sourceHeading, h5: sourceHeading, h6: sourceHeading };

// /api/chapters 응답 모양: 내 역할, 현재 활성 문서, 그 문서의 장 목록
type Workspace = {
  role: Role;
  document: { id: string; title: string; year: string | null } | null;
  chapters: Chapter[];
};

// 서버 API 호출 도우미. 로그인 토큰을 Authorization 헤더에 붙여 보내고,
// 실패하면 서버가 보낸 { error } 메시지로 오류를 낸다(화면에 그대로 보여 주기 위해).
async function api(path: string, token: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "요청을 처리하지 못했습니다.");
  return body;
}

// 기록 날짜를 "10. 24." 같은 짧은 한국어 날짜로 바꾼다(최근 질문 목록용).
function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

export default function Home() {
  // 화면 상태
  //   token     : 로그인 액세스 토큰(없으면 로그인 화면을 보여 준다)
  //   workspace : 활성 문서와 장 목록 / chapter : 지금 선택한 장
  //   answer    : 지금 보여 주는 결과(새 질문의 결과 또는 다시 보는 기록) / message : 안내·오류 문구
  //   busy      : 요청 처리 중 여부(버튼 잠금)
  //   history   : 내 최근 질문 기록 / viewing : 다시 보고 있는 기록의 id(새 질문이면 null)
  //   selectedSource : 오른쪽 근거 패널에서 강조할 근거의 순서(0부터)
  const [supabase] = useState(browserSupabase);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [viewing, setViewing] = useState<HistoryItem | null>(null);
  const [selectedSource, setSelectedSource] = useState(0);

  // 내 최근 질문 기록을 불러온다(서버가 로그인한 본인의 기록만 돌려준다).
  const loadHistory = async (accessToken: string) => {
    const body = await api("/api/messages", accessToken) as { messages: HistoryItem[] };
    setHistory(body.messages);
  };

  // 장 목록과 질문 기록을 불러온다. 이미 고른 장이 새 목록에도 있으면 그대로 두고, 없으면 첫 장을 고른다.
  const loadWorkspace = async (accessToken: string) => {
    const next = await api("/api/chapters", accessToken) as Workspace;
    setWorkspace(next);
    setChapter((current) => next.chapters.find((item) => item.id === current?.id) ?? next.chapters[0] ?? null);
    await loadHistory(accessToken);
  };

  // 로그인 상태 감시. 화면이 처음 열릴 때 한 번 실행된다.
  // 로그인 링크는 메일에서 "새 창"으로 열리고, 그 창(/auth/callback)에서 세션이 저장된다.
  // 원래 창은 그 사실을 모르므로 1.5초마다 세션을 다시 확인한다(같은 브라우저라 세션 저장소를 함께 쓴다).
  // 콜백 창이 localStorage에 "baegotnuri-login-complete" 표시를 남기면 더는 확인하지 않는다.
  // onAuthStateChange는 로그인·로그아웃·토큰 갱신이 일어날 때마다 화면 상태를 맞춰 준다.
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
      else { setWorkspace(null); setChapter(null); setHistory([]); }
    });
    // 화면이 닫힐 때 타이머와 감시를 정리한다(메모리 누수 방지).
    return () => { window.clearInterval(timer); listener.subscription.unsubscribe(); };
  }, [supabase]);

  // 로그인 링크 요청. 이전 로그인 완료 표시를 지운 뒤 서버(/api/auth/request)에 메일 발송을 요청한다.
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

  // 질문 보내기. 선택한 장 id와 질문을 /api/ask로 보낸다.
  // approvedChapterId는 "다른 장을 확인해 볼까요?" 제안에서 "해당 장에서 답변받기"를 눌렀을 때만 넣는다.
  // 답변이 오면 서버가 기록을 저장했으므로 최근 질문 목록을 다시 불러온다.
  const ask = async (approvedChapterId?: string) => {
    if (!chapter || !question.trim()) return;
    setBusy(true); setAnswer(null); setMessage(""); setViewing(null); setSelectedSource(0);
    try {
      const result = await api("/api/ask", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapterId: chapter.id, question, approvedChapterId }) }) as AskResult;
      setAnswer(result);
      if (result.type === "answer") loadHistory(token).catch(() => undefined);
    } catch (error) { setMessage(error instanceof Error ? error.message : "답변을 만들지 못했습니다."); }
    finally { setBusy(false); }
  };

  // 질문 입력칸에서 Shift+Enter를 누르면 "질문하기" 버튼과 똑같이 전송한다. 그냥 Enter는 기본 동작(줄바꿈) 그대로다.
  //   - isComposing: 한글처럼 글자를 조합해 입력하는 중에는 Enter가 "조합 확정"에 쓰인다. 이때 전송하면
  //     마지막 글자가 빠지거나 두 번 들어갈 수 있으므로 조합이 끝난 뒤의 키 입력만 처리한다.
  //   - busy: 답변을 기다리는 중에 다시 보내지 않는다(버튼이 잠겨 있는 것과 같은 규칙).
  //   - preventDefault: 전송할 때는 입력칸에 줄바꿈이 추가되지 않게 막는다.
  const sendOnShiftEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !event.shiftKey || event.nativeEvent.isComposing || busy) return;
    event.preventDefault();
    ask();
  };

  // 왼쪽 장 목록에서 장을 고르면 검색 범위가 바뀌므로, 보이던 결과와 다시 보기 상태를 지운다.
  const chooseChapter = (item: Chapter) => {
    setChapter(item); setAnswer(null); setViewing(null);
  };

  // "다른 장을 확인해 볼까요?"에서 "해당 장에서 답변받기"를 누르면 왼쪽 목록에서도 그 장이 선택되게 한 뒤 다시 질문한다.
  const acceptSuggestion = (chapterId: string) => {
    const next = workspace?.chapters.find((item) => item.id === chapterId);
    if (next) setChapter(next);
    ask(chapterId);
  };

  // 최근 질문 기록을 다시 본다. 저장된 답변·근거를 그대로 띄우므로 모델을 다시 부르지 않는다(비용·시간 없음).
  // 질문 입력칸에도 그 질문을 채워 두어, 고쳐서 다시 물어볼 수 있게 한다.
  const openHistory = (item: HistoryItem) => {
    const itemChapter = workspace?.chapters.find((candidate) => candidate.id === item.chapter?.id);
    if (itemChapter) setChapter(itemChapter);
    setQuestion(item.question);
    setAnswer({ type: "answer", answer: item.answer, citations: item.citations, keywords: [] });
    setViewing(item);
    setSelectedSource(0);
    setMessage("");
  };

  // 오른쪽 근거 패널에서 index번째 근거를 강조하고 화면에 보이도록 스크롤한다(휴대폰처럼 세 단이 쌓인 화면에서 유용).
  const selectSource = (index: number) => {
    setSelectedSource(index);
    document.getElementById(`source-${index + 1}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // 답변 글 속 "[1]" 같은 인용 번호를 누를 수 있는 버튼으로 바꾼다. 누르면 오른쪽 근거가 강조된다.
  // 근거 목록에 없는 번호(모델이 잘못 쓴 번호)는 버튼으로 만들지 않고 글자 그대로 둔다.
  const renderAnswer = (text: string, citationCount: number) => text.split(/(\[\d+\])/g).map((part, index) => {
    const number = Number(part.match(/^\[(\d+)\]$/)?.[1]);
    if (!number || number > citationCount) return part;
    return <button key={index} type="button" className={selectedSource === number - 1 ? "cite active" : "cite"} onClick={() => selectSource(number - 1)} aria-label={`근거 ${number} 보기`}>[{number}]</button>;
  });

  // 로그인 전 화면: 학교 메일 입력 → 로그인 링크 받기
  if (!token) {
    return <main className="login-shell"><section className="login-card"><p className="eyebrow">배곧누리초등학교</p><h1>교육공무원<br />인사실무편람</h1><p>등록된 교직원만 이용할 수 있습니다.</p><form onSubmit={requestLogin}><label>학교 이메일<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@baegotnuri.es.kr" required /></label><button disabled={busy}>{busy ? "보내는 중…" : "로그인 링크 받기"}</button></form>{message && <p className="notice">{message}</p>}</section></main>;
  }

  // 로그인 후 화면: 왼쪽(장·최근 질문) / 가운데(질문·결과) / 오른쪽(근거) 세 단.
  // 세 단은 flex-wrap으로 배치되어 화면이 좁으면 위아래로 쌓인다(globals.css의 .wb).
  // 답변은 "○ " 항목과 줄바꿈이 있는 공문체라 CSS의 white-space: pre-wrap으로 줄바꿈을 그대로 보여 준다.
  const citations = answer?.type === "answer" ? answer.citations : [];
  return <div className="wb">
    <nav className="wb-nav" aria-label="장 목록과 최근 질문">
      <div><p className="wb-eyebrow">인사실무편람</p><p className="wb-doc">{workspace?.document?.title ?? "아직 활성화된 문서가 없습니다."}</p></div>
      <div className="wb-list">{workspace?.chapters.map((item) => <button key={item.id} type="button" className={chapter?.id === item.id ? "wb-chapter active" : "wb-chapter"} aria-current={chapter?.id === item.id ? "true" : undefined} onClick={() => chooseChapter(item)}><span><span className="wb-chapter-number">{item.chapter_number}</span>{item.title}</span><span className="wb-chapter-pages">{item.page_from}~{item.page_to}쪽</span></button>)}</div>
      <div className="wb-list"><p className="wb-eyebrow">최근 질문</p>{history.length ? history.map((item) => <button key={item.id} type="button" className={viewing?.id === item.id ? "wb-history active" : "wb-history"} onClick={() => openHistory(item)}><span className="wb-history-meta">{item.chapter ? `${item.chapter.chapter_number}장 · ` : ""}{shortDate(item.created_at)}</span><span className="wb-history-question">{item.question}</span></button>) : <p className="wb-empty">아직 질문 기록이 없습니다.</p>}</div>
      <div className="wb-nav-footer">{(workspace?.role === "admin" || workspace?.role === "leader") && <a href="/records">전체 질문 기록</a>}{workspace?.role === "admin" && <a href="/admin">관리자 페이지</a>}<button type="button" onClick={() => { localStorage.removeItem("baegotnuri-login-complete"); supabase.auth.signOut(); }}>로그아웃</button></div>
    </nav>

    <main className="wb-main">
      {message && <p className="notice">{message}</p>}
      {chapter && <div className="wb-title"><h1>{chapter.chapter_number} {chapter.title}</h1><span>{chapter.page_from}~{chapter.page_to}쪽 안에서만 근거를 찾습니다</span></div>}
      {chapter && <section className="question-card"><h2>무엇이 궁금하신가요?</h2><textarea aria-label="질문 입력" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={sendOnShiftEnter} placeholder="예: 승진후보자명부는 어떤 기준으로 작성하나요?" rows={3} /><div className="question-actions"><span>Shift+Enter로 보내기 · Enter는 줄바꿈</span><button onClick={() => ask()} disabled={busy || !question.trim()}>{busy ? "근거를 찾는 중…" : "질문하기"}</button></div></section>}
      {viewing && <p className="notice">{shortDate(viewing.created_at)}에 한 질문의 기록입니다. 저장된 답변과 근거를 그대로 보여 줍니다.</p>}
      {answer?.type === "suggestion" && <section className="result-card suggestion"><h2>다른 장을 확인해 볼까요?</h2><p>질문의 핵심어 “{answer.keywords.join(", ") || "관련 내용"}”가 <strong>{answer.chapter.chapter_number} {answer.chapter.title}</strong>에 포함된 것으로 보입니다.</p><div className="actions"><button disabled={busy} onClick={() => acceptSuggestion(answer.chapter.id)}>해당 장에서 답변받기</button><button className="secondary" onClick={() => setAnswer(null)}>현재 장 유지</button></div></section>}
      {answer?.type === "not_found" && <section className="result-card"><h2>확인할 수 없습니다</h2><p>{answer.message}</p></section>}
      {answer?.type === "answer" && <section className="result-card"><h2>안내</h2><p className="answer-text">{renderAnswer(answer.answer, answer.citations.length)}</p></section>}
    </main>

    <aside className="wb-sources" aria-label="확인한 근거">
      <div className="wb-sources-head"><h2>확인한 근거</h2>{citations.length > 0 && <span>{citations.length}건 · [{selectedSource + 1}] 선택됨</span>}</div>
      {citations.length ? citations.map((citation, index) => <section key={citation.chunkId} id={`source-${index + 1}`} className={selectedSource === index ? "wb-source active" : "wb-source"}><button type="button" className="wb-source-title" onClick={() => setSelectedSource(index)}>[{index + 1}] {citation.heading || chapter?.title} <span>· {citation.pageFrom}~{citation.pageTo}쪽</span></button><div className="source-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={SOURCE_MARKDOWN}>{citation.excerpt}</ReactMarkdown></div></section>) : <p className="wb-placeholder">답변을 받으면 근거 원문이 여기에 표시됩니다.</p>}
    </aside>
  </div>;
}
