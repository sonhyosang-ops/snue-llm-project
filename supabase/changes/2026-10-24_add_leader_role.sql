-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-24 사용자 역할에 교장·교감(leader) 추가
--
-- 역할 3단계: admin(관리자) / leader(교장·교감) / user(교사)
-- 기존 DB는 allowed_users.role에 'admin', 'user'만 허용하는 check 제약이 있어 'leader'를 저장할 수 없다.
-- Supabase 대시보드 → SQL Editor에 이 파일 내용을 붙여 넣고 한 번 실행한다(여러 번 실행해도 결과는 같다).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) role 열에 걸린 기존 check 제약을 이름과 상관없이 찾아 지운다.
--    (제약 이름은 만들 때 자동으로 붙어 DB마다 다를 수 있으므로, 정의에 'role'이 들어간 check 제약을 찾는다.
--     메일을 소문자로 강제하는 다른 check 제약은 정의에 'role'이 없으므로 건드리지 않는다.)
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
      and rel.relname = 'allowed_users'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%role%'
  loop
    execute format('alter table public.allowed_users drop constraint %I', constraint_name);
  end loop;
end $$;

-- 2) 세 가지 역할을 허용하는 제약을 새로 만든다. 기존 'admin', 'user' 행은 그대로 유효하다.
alter table public.allowed_users
  add constraint allowed_users_role_check check (role in ('admin', 'leader', 'user'));
