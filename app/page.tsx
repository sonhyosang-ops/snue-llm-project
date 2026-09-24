"use client";

import { FormEvent, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

type Role = "teacher" | "vice_principal" | "academic_affairs" | "system_developer";
type Profile = { id: string; email: string; role: Role; can_upload: boolean };
type Chapter = {
  id: string;
  title: string;
  summary: string;
  first_published_at: string | null;
  last_updated_at: string | null;
  source_documents: { title: string } | null;
};
type Source = { documentTitle: string; chapterTitle: string; pageFrom: number | null };
type ChatResult = { answer: string; sources: Source[]; suggestions: { id: string; title: string }[] };

const roleLabel: Record<Role, string> = {
  teacher: "일반 교사",
  vice_principal: "교감",
  academic_affairs: "교무",
  system_developer: "시스템 개발자",
};

const formatDate = (value: string | null) =>
  value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(value)) : "-";

export default function Home() {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState("");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [question, setQuestion] = useState("");
  const [chatResult, setChatResult] = useState<ChatResult | null>(null);
  const [chatting, setChatting] = useState(false);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [candidateVersion, setCandidateVersion] = useState<string | null>(null);
  const [adminProfiles, setAdminProfiles] = useState<Profile[]>([]);

  const canUpload = Boolean(profile && (profile.can_upload || profile.role !== "teacher"));
  const canPublish = Boolean(profile && profile.role !== "teacher");
  const canManageAccess = profile?.role === "system_developer" || profile?.role === "vice_principal";

  const loadProfile = async (currentUser: User) => {
    const { data } = await supabase
      .from("profiles")
      .select("id, email, role, can_upload")
      .eq("id", currentUser.id)
      .single();
    setProfile((data as Profile | null) ?? null);
  };

  const loadChapters = async () => {
    const { data } = await supabase
      .from("chapters")
      .select("id, title, summary, first_published_at, last_updated_at, source_documents(title)")
      .eq("is_active", true)
      .order("title");
    setChapters((data as Chapter[] | null) ?? []);
  };

  const loadAdminProfiles = async () => {
    const response = await fetch("/api/roles");
    if (response.ok) setAdminProfiles((await response.json()) as Profile[]);
  };

  useEffect(() => {
    queueMicrotask(() => {
      void loadChapters();
      void supabase.auth.getUser().then(({ data }) => {
        setUser(data.user);
        if (data.user) void loadProfile(data.user);
      });
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setProfile(null);
      if (session?.user) void loadProfile(session.user);
    });
    return () => subscription.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (canManageAccess) queueMicrotask(() => void loadAdminProfiles());
  }, [canManageAccess]);

  const requestLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    const allowed = /@baegotnuri\.es\.kr$/.test(normalizedEmail) || /@(?:[a-z0-9-]+\.)*snue\.ac\.kr$/.test(normalizedEmail);
    if (!allowed) {
      setNotice("배곧누리 또는 snue.ac.kr 계열 이메일만 사용할 수 있습니다.");
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setNotice(error ? error.message : "로그인 링크를 이메일로 보냈습니다. 메일을 열어 로그인해 주세요.");
  };

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedChapter || !question.trim()) return;
    setChatting(true);
    setChatResult(null);
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterId: selectedChapter.id, question: question.trim() }),
    });
    const data = (await response.json()) as ChatResult | { error: string };
    setChatting(false);
    if (!response.ok) {
      setNotice("error" in data ? data.error : "답변을 만들지 못했습니다.");
      return;
    }
    setChatResult(data as ChatResult);
  };

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!uploadFile || !uploadTitle.trim()) return;
    setUploading(true);
    setNotice("");
    const formData = new FormData();
    formData.set("file", uploadFile);
    formData.set("title", uploadTitle.trim());
    const response = await fetch("/api/ingest", { method: "POST", body: formData });
    const data = (await response.json()) as { versionId?: string; error?: string };
    setUploading(false);
    if (!response.ok || !data.versionId) {
      setNotice(data.error ?? "PDF 처리에 실패했습니다.");
      return;
    }
    setCandidateVersion(data.versionId);
    setNotice("챕터 후보를 만들었습니다. 내용을 확인한 뒤 게시하세요.");
  };

  const publish = async () => {
    if (!candidateVersion) return;
    const response = await fetch("/api/chapters/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId: candidateVersion }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setNotice(data.error ?? "게시하지 못했습니다.");
      return;
    }
    setCandidateVersion(null);
    setNotice("새 버전을 게시했습니다. 기존 같은 문서의 챕터는 새 버전으로 교체되었습니다.");
    await loadChapters();
  };

  const updateAccess = async (target: Profile) => {
    const response = await fetch("/api/roles", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id, role: target.role, canUpload: target.can_upload }),
    });
    if (response.ok) await loadAdminProfiles();
    else setNotice("권한을 저장하지 못했습니다.");
  };

  if (!user) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-16 text-slate-900">
        <section className="mx-auto max-w-lg rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold text-blue-700">배곧누리·서울교육대학교</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">학교 업무 지식 도우미</h1>
          <p className="mt-3 leading-7 text-slate-600">공식 업무 문서에서 근거를 찾아 안내합니다. 로그인 후 주제를 선택해 질문하세요.</p>
          <form className="mt-8 space-y-3" onSubmit={requestLogin}>
            <label className="block text-sm font-medium" htmlFor="email">학교 이메일</label>
            <input id="email" className="w-full rounded-xl border border-slate-300 px-4 py-3" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@baegotnuri.es.kr" type="email" required />
            <button className="w-full rounded-xl bg-blue-700 px-4 py-3 font-semibold text-white hover:bg-blue-800">로그인 링크 받기</button>
          </form>
          {notice && <p className="mt-4 text-sm text-slate-600">{notice}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div><p className="text-sm font-semibold text-blue-700">학교 업무 지식 도우미</p><p className="text-sm text-slate-500">{profile ? `${profile.email} · ${roleLabel[profile.role]}` : "권한 확인 중"}</p></div>
          <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void supabase.auth.signOut()}>로그아웃</button>
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-bold">업무 주제</h2><p className="mt-1 text-sm text-slate-500">주제를 먼저 선택하면 해당 자료만 검색합니다.</p>
          <div className="mt-4 space-y-2">{chapters.map((chapter) => <button key={chapter.id} onClick={() => { setSelectedChapter(chapter); setChatResult(null); }} className={`w-full rounded-xl border p-3 text-left ${selectedChapter?.id === chapter.id ? "border-blue-600 bg-blue-50" : "border-slate-200 hover:border-blue-300"}`}><span className="block font-medium">{chapter.title}</span><span className="mt-1 block text-xs text-slate-500">{chapter.source_documents?.title ?? "업무 문서"} · 업데이트 {formatDate(chapter.last_updated_at)}</span></button>)}{!chapters.length && <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-600">게시된 주제가 아직 없습니다.</p>}</div>
        </aside>
        <section className="space-y-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"><h2 className="text-xl font-bold">{selectedChapter ? selectedChapter.title : "질문할 주제를 선택하세요"}</h2><p className="mt-2 leading-6 text-slate-600">{selectedChapter?.summary || "왼쪽에서 업무 주제를 선택하면 간략한 안내와 질문 입력창이 표시됩니다."}</p>{selectedChapter && <form className="mt-5 flex gap-2" onSubmit={ask}><input className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="어떤 질문을 하고 싶은가요?" required /><button disabled={chatting} className="rounded-xl bg-blue-700 px-5 py-3 font-semibold text-white disabled:opacity-60">{chatting ? "검색 중" : "질문"}</button></form>}</div>
          {chatResult && <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"><h3 className="font-bold">답변</h3><p className="mt-3 whitespace-pre-wrap leading-7">{chatResult.answer}</p>{chatResult.sources.length > 0 && <div className="mt-5 border-t pt-4"><h4 className="text-sm font-semibold">답변 근거</h4><ul className="mt-2 space-y-1 text-sm text-slate-600">{chatResult.sources.map((source) => <li key={`${source.documentTitle}-${source.chapterTitle}-${source.pageFrom}`}>• {source.documentTitle} · {source.chapterTitle}{source.pageFrom ? ` · ${source.pageFrom}쪽` : ""}</li>)}</ul></div>}{chatResult.suggestions.length > 0 && <div className="mt-5 border-t pt-4"><p className="text-sm font-semibold">다른 주제에서 확인해 보세요</p><div className="mt-2 flex flex-wrap gap-2">{chatResult.suggestions.map((item) => <button key={item.id} onClick={() => setSelectedChapter(chapters.find((chapter) => chapter.id === item.id) ?? null)} className="rounded-full border border-blue-300 px-3 py-1 text-sm text-blue-700">{item.title}</button>)}</div></div>}</section>}
          {canUpload && <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"><h2 className="text-xl font-bold">관리자: PDF 데이터셋 만들기</h2><p className="mt-2 text-sm leading-6 text-slate-600">PDF를 업로드하면 챕터 후보와 검색용 문단을 만듭니다. 게시 전에는 교사에게 보이지 않습니다.</p><form className="mt-4 grid gap-3" onSubmit={upload}><input className="rounded-xl border border-slate-300 px-4 py-3" value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} placeholder="문서 제목 (예: 2026 학교업무 매뉴얼)" required /><input className="rounded-xl border border-slate-300 px-4 py-3" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} type="file" accept="application/pdf" required /><button disabled={uploading} className="rounded-xl bg-slate-900 px-4 py-3 font-semibold text-white disabled:opacity-60">{uploading ? "파싱·분할 중..." : "PDF 업로드 및 챕터 후보 만들기"}</button></form>{candidateVersion && canPublish && <button onClick={() => void publish()} className="mt-4 rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white">이 버전 게시하기</button>}</section>}
          {canManageAccess && <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"><h2 className="text-xl font-bold">관리자: 업로드 권한 관리</h2><p className="mt-2 text-sm text-slate-600">교사가 한 번 로그인하면 이 목록에 나타납니다. 역할과 추가 업로드 권한을 변경할 수 있습니다.</p><div className="mt-4 space-y-3">{adminProfiles.map((member) => <div key={member.id} className="grid gap-2 rounded-xl border border-slate-200 p-3 md:grid-cols-[1fr_180px_auto_auto]"><span className="self-center text-sm">{member.email}</span><select value={member.role} onChange={(event) => setAdminProfiles((items) => items.map((item) => item.id === member.id ? { ...item, role: event.target.value as Role } : item))} className="rounded-lg border border-slate-300 px-2 py-2">{Object.entries(roleLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={member.can_upload} onChange={(event) => setAdminProfiles((items) => items.map((item) => item.id === member.id ? { ...item, can_upload: event.target.checked } : item))} />추가 업로드</label><button className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void updateAccess(member)}>저장</button></div>)}</div></section>}
          {notice && <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{notice}</p>}
        </section>
      </div>
    </main>
  );
}
