create type public.school_role as enum (
  'teacher',
  'vice_principal',
  'academic_affairs',
  'system_developer'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role public.school_role not null default 'teacher',
  can_upload boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_allowed_school_email(value text)
returns boolean
language sql
immutable
as $$
  select lower(value) ~ '@baegotnuri\.es\.kr$'
      or lower(value) ~ '@([a-z0-9-]+\.)*snue\.ac\.kr$';
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_allowed_school_email(new.email) then
    raise exception '허용된 학교 이메일만 가입할 수 있습니다.';
  end if;

  insert into public.profiles (id, email, role, can_upload)
  values (
    new.id,
    lower(new.email),
    case when lower(new.email) = 'hyosang@baegotnuri.es.kr'
      then 'system_developer'::public.school_role
      else 'teacher'::public.school_role
    end,
    lower(new.email) = 'hyosang@baegotnuri.es.kr'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('system_developer', 'vice_principal')
  );
$$;

alter table public.profiles enable row level security;

create policy "users read their own profile"
on public.profiles for select to authenticated
using (id = auth.uid());

create policy "managers read all profiles"
on public.profiles for select to authenticated
using (public.is_manager());

create policy "managers update profiles"
on public.profiles for update to authenticated
using (public.is_manager())
with check (public.is_manager());
