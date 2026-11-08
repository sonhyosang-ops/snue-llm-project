"use client";

// ─────────────────────────────────────────────────────────────────────────────
// quiz/page.tsx — 문제 풀기 화면 (주소: /quiz, 로그인한 교직원 누구나)
//
// 관리자(교감·교장) 시험을 준비하는 교사가 편람 내용을 얼마나 이해했는지 스스로 확인하는 별도 화면이다.
// 메인 화면(/)의 왼쪽 메뉴 "문제 풀기"에서 새 창으로 열리며, 메인 화면의 질문·답변 흐름은 건드리지 않는다.
// 흐름: 장 고르기 → 출제 범위 고르기 → "문제 만들기"(/api/quiz) → 보기를 눌러 답하기(/api/quiz/answer)
//       → 바로 채점 결과·해설·근거 원문 → 다 풀면 이번 점수, 장별 누적 정답률
// 출제 범위
//   - 최근 문답 : 이 장에서 내가 한 상담의 "상황"을 소재로 하되, 이미 물은 쟁점이 아니라 같은 상황의 다른 쟁점을 묻는다.
//   - 이 장 전체 : 장 원문에서 무작위로 골라 묻는다(질문 기록이 없어도 된다).
// 정답은 서버만 알고 있다가 답을 보내면 알려 준다. 로그인은 메인 화면에서 한 세션을 같은 브라우저에서 이어 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { browserSupabase } from "@/lib/browser-supabase";
import type { Chapter, ManualTree, QuizAnswerResult, QuizQuestion, QuizScope, QuizStats } from "@/lib/types";

// 근거 원문의 "# 사례 7" 같은 제목은 굵은 한 줄로 그린다(메인 화면의 답변 출처와 같은 방식).
const sourceHeading: Components["h1"] = ({ children }) => <p className="source-heading"><strong>{children}</strong></p>;
const SOURCE_MARKDOWN: Components = { h1: sourceHeading, h2: sourceHeading, h3: sourceHeading, h4: sourceHeading, h5: sourceHeading, h6: sourceHeading };

// 서버 API 호출 도우미(메인 화면과 같다). 실패하면 서버가 보낸 { error } 문구로 오류를 낸다.
async function api(path: string, token: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  // 중간 서버(Vercel 등)가 거절하면 JSON이 아닌 평문이 올 수 있다. 먼저 글자로 받고 JSON이 아니면 상태 코드와 함께 그대로 보여 준다.
  const text = await response.text();
  let body: { error?: string } & Record<string, unknown>;
  try { body = JSON.parse(text); } catch { throw new Error(`서버 응답 오류 (${response.status}): ${text.slice(0, 120) || response.statusText}`); }
  if (!response.ok) throw new Error(body.error ?? "요청을 처리하지 못했습니다.");
  return body;
}

// 보기 글머리. 4지선다는 ①~④, O/X는 O·X 그대로.
const CHOICE_MARKS = ["①", "②", "③", "④"];

export default function QuizPage() {
  // 화면 상태
  //   token / manuals / chapter : 로그인 토큰, 매뉴얼별 장 목록, 고른 장
  //   scope                     : 출제 범위(recent / chapter)
  //   questions / results       : 이번에 만든 문제들과, 문제 id별 채점 결과(답한 문제만 들어 있다)
  //   stats                     : 고른 장의 누적 성적(서버가 출제·채점 때마다 보내 준다)
  //   busy / grading / message  : 문제 만드는 중, 채점 중인 문제 id, 안내·오류 문구
  const [supabase] = useState(browserSupabase);
  const [token, setToken] = useState("");
  const [manuals, setManuals] = useState<ManualTree[]>([]);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [scope, setScope] = useState<QuizScope>("recent");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [results, setResults] = useState<Record<string, QuizAnswerResult>>({});
  const [stats, setStats] = useState<QuizStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [grading, setGrading] = useState("");
  const [message, setMessage] = useState("");

  const allChapters = manuals.flatMap((manual) => manual.chapters);

  // 화면이 열리면 로그인 세션을 읽고 장 목록을 불러온다. 첫 장을 기본으로 고른다.
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const accessToken = data.session?.access_token ?? "";
      setToken(accessToken);
      if (!accessToken) return;
      try {
        const body = await api("/api/chapters", accessToken) as { manuals: ManualTree[] };
        setManuals(body.manuals);
        setChapter(body.manuals[0]?.chapters[0] ?? null);
      } catch (error) { setMessage(error instanceof Error ? error.message : "장 목록을 불러오지 못했습니다."); }
    });
  }, [supabase]);

  // 장을 바꾸면 보던 문제와 성적은 그 장의 것이 아니므로 비운다.
  const chooseChapter = (chapterId: string) => {
    setChapter(allChapters.find((item) => item.id === chapterId) ?? null);
    setQuestions([]); setResults({}); setStats(null); setMessage("");
  };

  // 문제 만들기. 서버가 모델로 문제를 만들고 근거를 검증한 뒤 정답을 뺀 문제만 보낸다. 1분 안팎 걸린다(실측 40~70초).
  const createQuiz = async () => {
    if (!chapter) return;
    setBusy(true); setMessage(""); setQuestions([]); setResults({});
    try {
      const body = await api("/api/quiz", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapterId: chapter.id, scope }) }) as { questions: QuizQuestion[]; stats: QuizStats };
      setQuestions(body.questions);
      setStats(body.stats);
    } catch (error) { setMessage(error instanceof Error ? error.message : "문제를 만들지 못했습니다."); }
    finally { setBusy(false); }
  };

  // 답하기. 보기를 누르면 바로 서버가 채점하고 정답·해설·근거를 돌려준다. 한 문제는 한 번만 답한다.
  const answer = async (question: QuizQuestion, value: string) => {
    if (results[question.id] || grading) return;
    setGrading(question.id); setMessage("");
    try {
      const result = await api("/api/quiz/answer", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId: question.id, answer: value }) }) as QuizAnswerResult;
      setResults((current) => ({ ...current, [question.id]: { ...result, answer: result.answer, chosen: value } as QuizAnswerResult & { chosen: string } }));
      setStats(result.stats);
    } catch (error) { setMessage(error instanceof Error ? error.message : "채점하지 못했습니다."); }
    finally { setGrading(""); }
  };

  // 로그인하지 않았으면 메인 화면에서 먼저 로그인하라고 안내한다.
  if (!token) return <main className="login-shell"><section className="login-card"><p className="eyebrow">문제 풀기</p><h1>로그인이 필요합니다</h1><p>먼저 메인 화면에서 학교 이메일로 로그인한 뒤 이 페이지를 열어 주세요.</p><a className="text-button" href="/">메인 화면으로 이동</a></section></main>;

  const answered = questions.filter((question) => results[question.id]);
  const correctCount = answered.filter((question) => results[question.id].correct).length;
  const finished = questions.length > 0 && answered.length === questions.length;

  // 화면 구성: 머리말 → 출제 설정(장·범위·만들기) → 문제 카드들 → 이번 점수와 누적 성적
  return <main className="app-shell">
    <header><div><p className="eyebrow">이해도 확인</p><h1>문제 풀기</h1></div><div><a className="text-button" href="/">사용자 화면</a></div></header>
    <p className="notice">편람 원문으로 만든 O/X·4지선다 문제를 풀어 봅니다. 정답·해설과 함께 근거 원문을 바로 확인할 수 있습니다.</p>

    <section className="question-card quiz-setup">
      <label>장<select value={chapter?.id ?? ""} onChange={(event) => chooseChapter(event.target.value)} disabled={busy}>{manuals.map((manual) => <optgroup key={manual.id} label={manual.title}>{manual.chapters.map((item) => <option key={item.id} value={item.id}>{item.chapter_number} {item.title}</option>)}</optgroup>)}</select></label>
      <fieldset className="quiz-scope"><legend>출제 범위</legend>
        <label className="quiz-radio"><input type="radio" name="scope" checked={scope === "recent"} onChange={() => setScope("recent")} disabled={busy} /><span><strong>최근 문답</strong><small>이 장에서 내가 상담한 상황을 소재로, 이미 물은 것과 다른 쟁점을 묻습니다.</small></span></label>
        <label className="quiz-radio"><input type="radio" name="scope" checked={scope === "chapter"} onChange={() => setScope("chapter")} disabled={busy} /><span><strong>이 장 전체</strong><small>장 원문에서 무작위로 골라 묻습니다. 질문 기록이 없어도 됩니다.</small></span></label>
      </fieldset>
      <div className="actions"><button onClick={createQuiz} disabled={busy || !chapter}>{busy ? "문제를 만드는 중… (1분 안팎)" : questions.length ? "새 문제 만들기" : "문제 만들기"}</button>{stats && stats.total > 0 && <span className="quiz-stat">이 장 누적: {stats.total}문제 중 {stats.correct}개 정답 ({Math.round((stats.correct / stats.total) * 100)}%)</span>}</div>
      {message && <p className="notice">{message}</p>}
    </section>

    {questions.map((question, index) => {
      const result = results[question.id] as (QuizAnswerResult & { chosen: string }) | undefined;
      const options = question.kind === "ox" ? ["O", "X"] : ["1", "2", "3", "4"];
      return <section key={question.id} className={result ? (result.correct ? "result-card quiz-item correct" : "result-card quiz-item wrong") : "result-card quiz-item"}>
        <p className="turn-question"><span className="eyebrow">문제 {index + 1} · {question.kind === "ox" ? "O/X" : "4지선다"}</span>{question.prompt}</p>
        <div className="quiz-choices">{options.map((value, optionIndex) => {
          // 채점 뒤에는 정답 보기를 초록, 내가 고른 오답을 빨강으로 표시한다.
          const state = result ? (value === result.answer ? " correct" : value === result.chosen ? " wrong" : "") : "";
          return <button key={value} type="button" className={`quiz-choice${state}`} disabled={Boolean(result) || grading === question.id} onClick={() => answer(question, value)}><span className="quiz-mark">{question.kind === "ox" ? value : CHOICE_MARKS[optionIndex]}</span>{question.kind === "ox" ? (value === "O" ? "맞습니다" : "틀립니다") : question.choices[optionIndex]}</button>;
        })}</div>
        {result && <div className="quiz-result">
          <p className="quiz-verdict">{result.correct ? "정답입니다." : `틀렸습니다. 정답은 ${question.kind === "ox" ? result.answer : CHOICE_MARKS[Number(result.answer) - 1]}입니다.`}</p>
          <p className="answer-text">{result.explanation}</p>
          <details className="quiz-source"><summary>근거 원문 · {result.citation.heading || chapter?.title} ({result.citation.pageFrom}~{result.citation.pageTo}쪽)</summary><div className="source-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={SOURCE_MARKDOWN}>{result.citation.excerpt}</ReactMarkdown></div></details>
        </div>}
      </section>;
    })}

    {finished && <section className="result-card quiz-score"><h2>이번 결과</h2><p>{questions.length}문제 중 <strong>{correctCount}개</strong> 정답입니다.{stats && ` 이 장 누적 정답률은 ${Math.round((stats.correct / stats.total) * 100)}%입니다.`}</p><div className="actions"><button onClick={createQuiz} disabled={busy}>같은 설정으로 새 문제 만들기</button></div></section>}
  </main>;
}
