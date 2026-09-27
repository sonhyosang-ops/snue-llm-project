create extension if not exists vector;

create table if not exists public.allowed_users (
  email text primary key check (email = lower(email)),
  role text not null default 'user' check (role in ('admin', 'user')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

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
create index if not exists chunks_chapter_id_idx on public.chunks(chapter_id, ord);

create table if not exists public.embeddings (
  chunk_id uuid primary key references public.chunks(id) on delete cascade,
  embedding vector not null,
  model text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.chapter_keywords (
  id bigint generated always as identity primary key,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  term text not null,
  frequency integer not null,
  score real not null,
  unique (chapter_id, term)
);
create index if not exists chapter_keywords_chapter_id_idx on public.chapter_keywords(chapter_id, score desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  chapter_id uuid not null references public.chapters(id),
  question text not null,
  answer text not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

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

alter table public.allowed_users enable row level security;
alter table public.documents enable row level security;
alter table public.chapters enable row level security;
alter table public.chunks enable row level security;
alter table public.embeddings enable row level security;
alter table public.chapter_keywords enable row level security;
alter table public.messages enable row level security;

-- This MVP accesses application data only through Vercel server routes.
-- No browser-side table policies are intentionally created.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

insert into storage.buckets (id, name, public)
values ('personnel-pdfs', 'personnel-pdfs', false)
on conflict (id) do nothing;

-- Run this once, then change the email to the first system administrator.
-- insert into public.allowed_users (email, role) values ('admin@baegotnuri.es.kr', 'admin');
