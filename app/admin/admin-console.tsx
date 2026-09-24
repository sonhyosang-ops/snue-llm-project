"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Role = "teacher" | "vice_principal" | "academic_affairs" | "system_developer";
type Profile = { id: string; email: string; role: Role; can_upload: boolean };

const roleLabel: Record<Role, string> = {
  teacher: "일반 교사",
  vice_principal: "교감",
  academic_affairs: "교무",
  system_developer: "시스템 개발자",
};

export function AdminConsole() {
  const [members, setMembers] = useState<Profile[]>([]);
  const [notice, setNotice] = useState("목록을 불러오는 중입니다.");

  useEffect(() => {
    void fetch("/api/roles")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error);
        return response.json() as Promise<Profile[]>;
      })
      .then((profiles) => {
        setMembers(profiles);
        setNotice("");
      })
      .catch((error: Error) => setNotice(error.message || "목록을 불러오지 못했습니다."));
  }, []);

  const updateMember = async (member: Profile) => {
    setNotice("");
    const response = await fetch("/api/roles", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: member.id, role: member.role, canUpload: member.can_upload }),
    });
    const result = await response.json() as { error?: string };
    setNotice(response.ok ? `${member.email}의 권한을 저장했습니다.` : result.error || "권한을 저장하지 못했습니다.");
  };

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-900">
      <section className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-blue-700">관리자 전용</p>
            <h1 className="mt-1 text-3xl font-bold">학교 업무 지식 도우미 관리</h1>
            <p className="mt-2 text-slate-600">교사 로그인 후 계정이 목록에 나타납니다. 역할과 추가 PDF 업로드 권한을 관리하세요.</p>
          </div>
          <Link className="rounded-lg border border-slate-300 px-3 py-2 text-sm" href="/">서비스로 돌아가기</Link>
        </header>

        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-xl font-bold">계정 및 업로드 권한</h2>
          <div className="mt-4 space-y-3">
            {members.map((member) => (
              <div key={member.id} className="grid gap-3 rounded-xl border border-slate-200 p-4 md:grid-cols-[1fr_180px_auto_auto]">
                <span className="self-center break-all text-sm">{member.email}</span>
                <select className="rounded-lg border border-slate-300 px-2 py-2" value={member.role} onChange={(event) => setMembers((items) => items.map((item) => item.id === member.id ? { ...item, role: event.target.value as Role } : item))}>
                  {Object.entries(roleLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={member.can_upload} onChange={(event) => setMembers((items) => items.map((item) => item.id === member.id ? { ...item, can_upload: event.target.checked } : item))} />추가 업로드</label>
                <button className="rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white" onClick={() => void updateMember(member)}>저장</button>
              </div>
            ))}
          </div>
          {notice && <p className="mt-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">{notice}</p>}
        </section>
      </section>
    </main>
  );
}
