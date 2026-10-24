-- ─────────────────────────────────────────────────────────────────────────────
-- schema.sql — Supabase(PostgreSQL) 데이터베이스 구조
-- 새 Supabase 프로젝트의 SQL Editor에서 한 번 실행하면 이 앱에 필요한 테이블·함수·저장소가 만들어진다.
--
-- 데이터 흐름(RAG 기준)
--   documents(업로드한 PDF) ─┬─ chapters(장 = 검색 범위)
--                             │     ├─ chunks(검색 단위 본문) ── embeddings(청크의 의미 벡터)
--                             │     ├─ chapter_keywords(장 안내용 핵심어 사전)
--                             │     └─ messages(질문·답변 기록)
--   allowed_users(로그인 허용 목록), Storage 버킷 personnel-pdfs(원본 PDF)
-- ─────────────────────────────────────────────────────────────────────────────

-- pgvector 확장: 벡터(숫자 배열)를 저장하고 벡터끼리의 거리를 계산하는 기능을 PostgreSQL에 더한다.
-- 임베딩 검색(의미가 가까운 청크 찾기)이 이 확장 덕분에 DB 안에서 바로 이루어진다.
create extension if not exists vector;

-- 로그인 허용 목록. 여기 있고 enabled=true인 메일만 로그인 링크를 받고 API를 쓸 수 있다.
-- 메일은 소문자로만 저장하도록 check 조건을 둔다(대소문자가 달라 같은 사람이 두 번 등록되는 일 방지).
-- role(권한 층위): admin 관리자 / leader 교장·교감 / user 교사.
-- (2026-10-24에 leader 추가. 그 전에 만든 DB는 supabase/changes/2026-10-24_add_leader_role.sql을 실행해야 한다.)
create table if not exists public.allowed_users (
  email text primary key check (email = lower(email)),
  role text not null default 'user' check (role in ('admin', 'leader', 'user')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- 업로드한 문서(PDF) 하나당 한 행. status는 uploaded → processing → ready(성공) 또는 failed(실패)로 바뀐다.
-- is_active=true인 문서 하나만 사용자 화면에 보이고 검색 대상이 된다. 실패 원인은 error 열에 남는다.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  year text,
  storage_path text not null,
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  error text,
  is_active boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

-- 문서의 최상위 장. 사용자는 장을 골라 그 범위 안에서만 질문한다.
-- on delete cascade: 문서를 지우면 그 문서의 장도 자동으로 지워진다(아래 테이블들도 같은 방식으로 이어진다).
create table if not exists public.chapters (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chapter_number text not null default '',
  title text not null,
  page_from integer not null,
  page_to integer not null,
  display_order integer not null,
  unique (document_id, display_order)
);

-- 검색 단위 본문(약 1,200자). ord는 장 안에서의 순서, page_from~page_to는 원문 쪽 범위다.
create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  ord integer not null,
  heading text not null default '',
  page_from integer not null,
  page_to integer not null,
  content text not null
);
-- 장 단위로 청크를 찾는 일이 많으므로 (장, 순서)에 색인(index)을 둔다.
create index if not exists chunks_chapter_id_idx on public.chunks(chapter_id, ord);

-- 청크마다 의미 벡터 하나. model 열에 어떤 임베딩 모델로 만들었는지 남긴다(모델을 바꾸면 다시 만들어야 한다).
create table if not exists public.embeddings (
  chunk_id uuid primary key references public.chunks(id) on delete cascade,
  embedding vector not null,
  model text not null,
  created_at timestamptz not null default now()
);

-- 장별 핵심어 사전. 질문이 선택한 장과 맞는지, 아니면 다른 장을 안내할지 판단하는 데 쓴다.
-- frequency는 장 안 출현 횟수, score는 TF-IDF 점수다. 같은 장에 같은 낱말은 한 번만 들어간다(unique).
create table if not exists public.chapter_keywords (
  id bigint generated always as identity primary key,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  term text not null,
  frequency integer not null,
  score real not null,
  unique (chapter_id, term)
);
create index if not exists chapter_keywords_chapter_id_idx on public.chapter_keywords(chapter_id, score desc);

-- 질문·답변 기록. citations에는 답변에 쓴 근거 목록을 JSON으로 저장한다.
-- 주의: chapter_id는 cascade가 아니므로, 질문 기록이 있는 장(문서)은 기록을 먼저 지우지 않으면 지울 수 없다.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  chapter_id uuid not null references public.chapters(id),
  question text not null,
  answer text not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- 임베딩 검색 함수: 대상 장(target_chapter)의 청크 중 질문 벡터와 가장 가까운 match_count개를 돌려준다.
--   <=> 는 pgvector의 "코사인 거리" 연산자다(0이면 방향이 같음 = 의미가 같음, 클수록 다름).
--   similarity = 1 - 거리 이므로 1에 가까울수록 질문과 비슷한 청크다.
-- 서버(api/ask/route.ts)가 supabase.rpc("match_chapter_chunks", …)로 부른다.
create or replace function public.match_chapter_chunks(query_embedding vector, target_chapter uuid, match_count integer default 5)
returns table (id uuid, content text, heading text, page_from integer, page_to integer, similarity real)
language sql stable
as $$
  select c.id, c.content, c.heading, c.page_from, c.page_to,
         (1 - (e.embedding <=> query_embedding))::real as similarity
  from public.chunks c
  join public.embeddings e on e.chunk_id = c.id
  where c.chapter_id = target_chapter
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

-- 행 단위 보안(RLS)을 모든 테이블에 켠다. RLS가 켜진 테이블은 허용 정책(policy)이 없으면
-- 공개 키(anon)나 로그인 사용자 자격으로는 한 행도 읽거나 쓸 수 없다.
alter table public.allowed_users enable row level security;
alter table public.documents enable row level security;
alter table public.chapters enable row level security;
alter table public.chunks enable row level security;
alter table public.embeddings enable row level security;
alter table public.chapter_keywords enable row level security;
alter table public.messages enable row level security;

-- 이 앱은 데이터를 Vercel 서버 API를 통해서만 읽고 쓴다.
-- 그래서 브라우저용 허용 정책은 일부러 하나도 만들지 않았다(브라우저에서 테이블에 직접 접근 불가).

-- 서버가 쓰는 service_role(관리자 키)에는 모든 테이블·함수 권한을 준다. service_role은 RLS의 제한도 받지 않는다.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- 원본 PDF를 저장할 Storage 버킷. public=false라 주소를 알아도 외부에서 내려받을 수 없다.
insert into storage.buckets (id, name, public)
values ('personnel-pdfs', 'personnel-pdfs', false)
on conflict (id) do nothing;

-- 처음 한 번만: 아래 메일을 첫 관리자 메일로 바꾸고 주석(--)을 지운 뒤 실행한다.
-- 첫 관리자가 생기면 그다음부터는 관리자 화면(/admin)에서 사용자를 등록할 수 있다.
-- insert into public.allowed_users (email, role) values ('admin@baegotnuri.es.kr', 'admin');

-- 예전 구조(2026-10-24 확인): 초기 설계 때 만든 것이 실제 DB에 남아 있지만,
-- 이 파일로는 만들지 않고 앱 코드에서도 쓰지 않는다. 사용자 역할은 allowed_users.role 하나로 관리한다.
--   테이블 public.profiles (id, email, role public.school_role, can_upload, created_at, updated_at)
--   타입   public.school_role
--   함수   public.is_manager, public.is_allowed_school_email, public.rls_auto_enable
