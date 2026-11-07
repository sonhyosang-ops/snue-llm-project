-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-24 여러 업무 매뉴얼 지원 + 목차 확인 단계
--
-- 구조를 "매뉴얼 → 판(문서) → 장"으로 넓힌다.
--   manuals              : 업무 매뉴얼(예: 인사업무실무편람, ○○업무 매뉴얼). 사이드바의 큰 묶음이다.
--   documents.manual_id  : 이 PDF가 어느 매뉴얼의 판인지. 매뉴얼마다 운영 중(is_active)인 판은 하나다.
--   documents.outline_draft / page_count : 목차 분석 초안과 PDF 쪽수. 관리자가 확인·수정해 확정하기 전까지 보관한다.
--   documents.status에 'review'(목차 확인 대기) 추가
--
-- Supabase 대시보드 → SQL Editor에 이 파일 내용을 붙여 넣고 한 번 실행한다(여러 번 실행해도 결과는 같다).
-- 반드시 이 SQL을 먼저 실행한 뒤 새 코드를 배포한다(새 코드가 이 열들을 사용한다).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) 매뉴얼 테이블
create table if not exists public.manuals (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.manuals enable row level security;
grant select, insert, update, delete on public.manuals to service_role;

-- 2) 문서에 매뉴얼 연결·목차 초안·쪽수 열 추가
alter table public.documents add column if not exists manual_id uuid references public.manuals(id);
alter table public.documents add column if not exists outline_draft jsonb;
alter table public.documents add column if not exists page_count integer;

-- 3) 지금까지 올린 문서는 모두 "인사업무실무편람"의 판으로 옮긴다.
insert into public.manuals (title, display_order) values ('인사업무실무편람', 1) on conflict (title) do nothing;
update public.documents set manual_id = (select id from public.manuals where title = '인사업무실무편람') where manual_id is null;
alter table public.documents alter column manual_id set not null;

-- 4) 문서 상태에 'review'(목차 확인 대기)를 추가한다.
--    status 열에 걸린 기존 check 제약을 이름과 상관없이 찾아 지운 뒤 다시 만든다.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'documents'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%status%'
  loop
    execute format('alter table public.documents drop constraint %I', constraint_name);
  end loop;
end $$;
alter table public.documents
  add constraint documents_status_check check (status in ('uploaded', 'review', 'processing', 'ready', 'failed'));
