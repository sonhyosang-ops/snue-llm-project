-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-11-08 변경: 문제 풀기(이해도 확인) 테이블 추가
--
-- 배경: 관리자(교감·교장) 시험을 준비하는 교사가 편람 내용을 얼마나 이해했는지 스스로 확인할 수 있도록,
--       자기 문답 기록의 근거(또는 선택한 장 원문)로 O/X·4지선다 문제를 만들어 풀고 결과를 남긴다.
-- 구조: quiz_questions — 만들어진 문제 하나(정답·해설·근거 원문 포함). 정답은 서버만 보고, 화면에는 채점 뒤에 보낸다.
--       quiz_attempts  — 사용자가 문제에 답한 기록 하나(맞음/틀림). 장별 누적 정답률은 이 표를 세어 계산한다.
-- 적용: Supabase SQL Editor에서 이 파일을 한 번 실행한다(schema.sql에도 같은 내용이 들어 있다).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  chapter_id uuid not null references public.chapters(id),
  source text not null check (source in ('recent', 'chapter')),   -- recent: 내 최근 문답의 근거 / chapter: 장 원문 무작위
  kind text not null check (kind in ('ox', 'choice')),            -- ox: O/X / choice: 4지선다
  prompt text not null,                                           -- 문항
  choices jsonb not null default '[]'::jsonb,                     -- 4지선다 보기 4개(O/X는 빈 배열)
  answer text not null,                                           -- 정답: 'O'·'X' 또는 '1'~'4'
  explanation text not null,                                      -- 해설(근거 원문의 문장으로만 쓴다)
  evidence text not null,                                         -- 근거 원문에서 그대로 옮긴 문장(서버가 원문에 있는지 검사한 것)
  citation jsonb not null,                                        -- 화면에 보여 줄 근거 {chunkId, heading, pageFrom, pageTo, excerpt}
  created_at timestamptz not null default now()
);
create index if not exists quiz_questions_user_chapter_idx on public.quiz_questions(user_id, chapter_id, created_at desc);

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id),
  answer text not null,
  correct boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists quiz_attempts_user_chapter_idx on public.quiz_attempts(user_id, chapter_id);

-- 다른 테이블과 같이 RLS만 켜고 브라우저용 정책은 두지 않는다(서버 API가 service_role로만 읽고 쓴다).
alter table public.quiz_questions enable row level security;
alter table public.quiz_attempts enable row level security;
grant select, insert, update, delete on public.quiz_questions, public.quiz_attempts to service_role;
