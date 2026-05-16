create extension if not exists pgcrypto;

create table if not exists public.user_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  app_state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.allowed_emails (
  email text primary key,
  full_name text,
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  valid_until date,
  valid_until_at timestamptz,
  temp_password text,
  must_change_password boolean not null default true,
  is_trial boolean not null default false,
  account_created_at timestamptz,
  claimed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  valid_until date,
  valid_until_at timestamptz,
  is_trial boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

alter table public.allowed_emails
  add column if not exists valid_until_at timestamptz,
  add column if not exists is_trial boolean not null default false;

alter table public.app_profiles
  add column if not exists valid_until_at timestamptz,
  add column if not exists is_trial boolean not null default false;

update public.allowed_emails
set valid_until_at = ((valid_until::text || ' 23:59:59')::timestamp at time zone 'America/Sao_Paulo')
where valid_until_at is null
  and valid_until is not null;

update public.app_profiles
set valid_until_at = ((valid_until::text || ' 23:59:59')::timestamp at time zone 'America/Sao_Paulo')
where valid_until_at is null
  and valid_until is not null;

create index if not exists app_profiles_email_idx on public.app_profiles (email);

alter table public.user_states enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.app_profiles enable row level security;
alter table public.user_states force row level security;
alter table public.allowed_emails force row level security;
alter table public.app_profiles force row level security;

revoke all on table public.user_states from anon, authenticated;
revoke all on table public.allowed_emails from anon, authenticated;
revoke all on table public.app_profiles from anon, authenticated;
grant select, insert, update, delete on table public.user_states to authenticated;
grant select, insert, update, delete on table public.allowed_emails to authenticated;
grant select, insert, update, delete on table public.app_profiles to authenticated;

create sequence if not exists public.trial_account_number_seq
  as bigint
  start with 1
  increment by 1;

drop function if exists public.get_my_access_status();
drop function if exists public.can_start_first_access(text, text);
drop function if exists public.next_trial_email();
drop function if exists public.admin_set_auth_ban(text, boolean);
drop function if exists public.admin_delete_access_account(text);

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from auth.users u
    join public.allowed_emails a on a.email = lower(u.email)
    where u.id = uid
      and a.role = 'admin'
      and a.status = 'active'
      and (
        (a.valid_until_at is not null and a.valid_until_at >= now())
        or (a.valid_until_at is null and (a.valid_until is null or a.valid_until >= current_date))
      )
  );
$$;

create or replace function public.has_active_access(user_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.allowed_emails a
    where a.email = lower(user_email)
      and a.status = 'active'
      and (
        (a.valid_until_at is not null and a.valid_until_at >= now())
        or (a.valid_until_at is null and (a.valid_until is null or a.valid_until >= current_date))
      )
  );
$$;

create or replace function public.get_my_access_status()
returns table (
  email text,
  full_name text,
  role text,
  status text,
  valid_until date,
  valid_until_at timestamptz,
  temp_password text,
  must_change_password boolean,
  is_trial boolean,
  account_created_at timestamptz,
  claimed_at timestamptz,
  effective_status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  current_email text;
begin
  current_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  if current_email = '' then
    return query
    select
      null::text,
      null::text,
      null::text,
      null::text,
      null::date,
      null::timestamptz,
      null::text,
      false,
      false,
      null::timestamptz,
      null::timestamptz,
      'missing'::text;
    return;
  end if;

  return query
  select
    coalesce(a.email, current_email) as email,
    a.full_name,
    coalesce(a.role, 'user') as role,
    coalesce(a.status, 'blocked') as status,
    a.valid_until,
    a.valid_until_at,
    a.temp_password,
    coalesce(a.must_change_password, false) as must_change_password,
    coalesce(a.is_trial, false) as is_trial,
    a.account_created_at,
    a.claimed_at,
    case
      when a.email is null then 'missing'
      when a.status = 'blocked' then 'blocked'
      when a.valid_until_at is not null and a.valid_until_at < now() then 'expired'
      when a.valid_until_at is null and a.valid_until is not null and a.valid_until < current_date then 'expired'
      else 'active'
    end as effective_status
  from (select current_email as email) e
  left join public.allowed_emails a on a.email = e.email;
end;
$$;

create or replace function public.can_start_first_access(user_email text, temp_password_value text)
returns table (
  email text,
  full_name text,
  role text,
  status text,
  valid_until date,
  valid_until_at timestamptz,
  must_change_password boolean,
  is_trial boolean,
  effective_status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  normalized_email text;
begin
  normalized_email := lower(trim(coalesce(user_email, '')));

  if normalized_email = '' or coalesce(temp_password_value, '') = '' then
    return;
  end if;

  return query
  select
    a.email,
    a.full_name,
    coalesce(a.role, 'user') as role,
    coalesce(a.status, 'blocked') as status,
    a.valid_until,
    a.valid_until_at,
    coalesce(a.must_change_password, false) as must_change_password,
    coalesce(a.is_trial, false) as is_trial,
    case
      when a.status = 'blocked' then 'blocked'
      when a.valid_until_at is not null and a.valid_until_at < now() then 'expired'
      when a.valid_until_at is null and a.valid_until is not null and a.valid_until < current_date then 'expired'
      else 'active'
    end as effective_status
  from public.allowed_emails a
  where a.email = normalized_email
    and coalesce(a.temp_password, '') = temp_password_value
    and a.status = 'active'
    and (
      (a.valid_until_at is not null and a.valid_until_at >= now())
      or (a.valid_until_at is null and (a.valid_until is null or a.valid_until >= current_date))
    )
  limit 1;
end;
$$;

create or replace function public.next_trial_email()
returns text
language plpgsql
security definer
set search_path = public
volatile
as $$
declare
  next_number bigint;
  candidate_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem gerar perfil teste.';
  end if;

  loop
    next_number := nextval('public.trial_account_number_seq'::regclass);
    candidate_email := lower('teste' || lpad(next_number::text, 3, '0') || '@trial.controlefinanceiro.app');

    exit when not exists (
      select 1 from public.allowed_emails where email = candidate_email
    )
    and not exists (
      select 1 from public.app_profiles where email = candidate_email
    )
    and not exists (
      select 1 from auth.users where lower(email) = candidate_email
    );
  end loop;

  return candidate_email;
end;
$$;

create or replace function public.admin_set_auth_ban(target_email text, should_ban boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem alterar bloqueio de autenticação.';
  end if;

  normalized_email := lower(trim(coalesce(target_email, '')));
  if normalized_email = '' then
    raise exception 'E-mail inválido.';
  end if;

  if normalized_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Não altere a autenticação da própria conta administradora por aqui.';
  end if;

  update auth.users
     set banned_until = case when should_ban then '9999-12-31 23:59:59+00'::timestamptz else null end,
         updated_at = now()
   where lower(email) = normalized_email;

  return true;
end;
$$;

create or replace function public.admin_delete_access_account(target_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text;
  target_user_id uuid;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem excluir acessos.';
  end if;

  normalized_email := lower(trim(coalesce(target_email, '')));
  if normalized_email = '' then
    raise exception 'E-mail inválido.';
  end if;

  if normalized_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Não exclua a própria conta administradora por aqui.';
  end if;

  select id
    into target_user_id
  from auth.users
  where lower(email) = normalized_email
  limit 1;

  if target_user_id is not null then
    delete from public.user_states where user_id = target_user_id;
    delete from public.app_profiles where user_id = target_user_id;
    delete from auth.users where id = target_user_id;
  end if;

  delete from public.app_profiles where lower(email) = normalized_email;
  delete from public.allowed_emails where email = normalized_email;

  return true;
end;
$$;

create or replace function public.has_any_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.allowed_emails a
    where a.role = 'admin'
      and a.status = 'active'
  );
$$;

revoke all on function public.is_admin(uuid) from public;
revoke all on function public.has_active_access(text) from public;
revoke all on function public.get_my_access_status() from public;
revoke all on function public.can_start_first_access(text, text) from public;
revoke all on function public.next_trial_email() from public;
revoke all on function public.admin_set_auth_ban(text, boolean) from public;
revoke all on function public.admin_delete_access_account(text) from public;
revoke all on function public.has_any_admin() from public;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.has_active_access(text) to authenticated;
grant execute on function public.get_my_access_status() to authenticated;
grant execute on function public.can_start_first_access(text, text) to anon, authenticated;
grant execute on function public.next_trial_email() to authenticated;
grant execute on function public.admin_set_auth_ban(text, boolean) to authenticated;
grant execute on function public.admin_delete_access_account(text) to authenticated;
grant execute on function public.has_any_admin() to authenticated;

create or replace function public.sync_profile_from_allowed_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.allowed_emails%rowtype;
begin
  new.email := lower(new.email);

  select *
    into access_row
  from public.allowed_emails
  where email = new.email;

  if access_row.email is null then
    raise exception 'Email nao autorizado para uso.';
  end if;

  new.role := access_row.role;
  new.status := access_row.status;
  new.valid_until := access_row.valid_until;
  new.valid_until_at := access_row.valid_until_at;
  new.is_trial := coalesce(access_row.is_trial, false);
  new.full_name := coalesce(nullif(new.full_name, ''), access_row.full_name, new.full_name);
  new.updated_at := now();

  return new;
end;
$$;

drop trigger if exists trg_sync_profile_from_allowed_email on public.app_profiles;
create trigger trg_sync_profile_from_allowed_email
before insert or update on public.app_profiles
for each row
execute function public.sync_profile_from_allowed_email();

create or replace function public.sync_allowed_email_to_profiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.app_profiles
     set full_name = coalesce(new.full_name, app_profiles.full_name),
         role = new.role,
         status = new.status,
         valid_until = new.valid_until,
         valid_until_at = new.valid_until_at,
         is_trial = coalesce(new.is_trial, false),
         updated_at = now()
   where email = lower(new.email);

  return new;
end;
$$;

drop trigger if exists trg_sync_allowed_email_to_profiles on public.allowed_emails;
create trigger trg_sync_allowed_email_to_profiles
after insert or update on public.allowed_emails
for each row
execute function public.sync_allowed_email_to_profiles();

create or replace function public.mark_password_changed()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text;
begin
  current_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  if current_email = '' then
    raise exception 'Usuario autenticado nao encontrado.';
  end if;

  update public.allowed_emails
     set must_change_password = false,
         temp_password = null,
         claimed_at = coalesce(claimed_at, now()),
         updated_at = now()
   where email = current_email;

  if not found then
    raise exception 'Acesso administrado nao encontrado para este e-mail.';
  end if;

  update public.app_profiles
     set last_login_at = now(),
         updated_at = now()
   where email = current_email;
end;
$$;

revoke all on function public.mark_password_changed() from public;
grant execute on function public.mark_password_changed() to authenticated;

drop policy if exists "Users can read own state" on public.user_states;
drop policy if exists "Users can insert own state" on public.user_states;
drop policy if exists "Users can update own state" on public.user_states;
drop policy if exists "Users read own state or admins read all" on public.user_states;
drop policy if exists "Users insert own state or admins insert all" on public.user_states;
drop policy if exists "Users update own state or admins update all" on public.user_states;
drop policy if exists "Users delete own state or admins delete all" on public.user_states;
drop policy if exists "states select" on public.user_states;
drop policy if exists "states insert" on public.user_states;
drop policy if exists "states update" on public.user_states;
drop policy if exists "states delete" on public.user_states;

drop policy if exists "Admins can read allowed emails" on public.allowed_emails;
drop policy if exists "Admins can insert allowed emails" on public.allowed_emails;
drop policy if exists "Admins can update allowed emails" on public.allowed_emails;
drop policy if exists "Admins can delete allowed emails" on public.allowed_emails;
drop policy if exists "allowed select" on public.allowed_emails;
drop policy if exists "allowed insert" on public.allowed_emails;
drop policy if exists "allowed update" on public.allowed_emails;
drop policy if exists "allowed delete" on public.allowed_emails;

drop policy if exists "Users and admins can read profiles" on public.app_profiles;
drop policy if exists "Users bootstrap or create own profile" on public.app_profiles;
drop policy if exists "Users update own profile and admins manage all" on public.app_profiles;
drop policy if exists "Admins can delete profiles" on public.app_profiles;
drop policy if exists "profiles select" on public.app_profiles;
drop policy if exists "profiles insert" on public.app_profiles;
drop policy if exists "profiles update" on public.app_profiles;
drop policy if exists "profiles delete" on public.app_profiles;

create policy "allowed select"
on public.allowed_emails
for select
to authenticated
using (
  public.is_admin(auth.uid())
  or email = lower(coalesce(auth.jwt() ->> 'email', ''))
);

create policy "allowed insert"
on public.allowed_emails
for insert
to authenticated
with check (
  public.is_admin(auth.uid())
  or (
    not public.has_any_admin()
    and role = 'admin'
    and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

create policy "allowed update"
on public.allowed_emails
for update
to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

create policy "allowed delete"
on public.allowed_emails
for delete
to authenticated
using (public.is_admin(auth.uid()));

create policy "profiles select"
on public.app_profiles
for select
to authenticated
using (
  public.is_admin(auth.uid())
  or user_id = auth.uid()
);

create policy "profiles insert"
on public.app_profiles
for insert
to authenticated
with check (
  user_id = auth.uid()
  and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  and (
    public.has_active_access(lower(coalesce(auth.jwt() ->> 'email', '')))
    or (
      not public.has_any_admin()
      and role = 'admin'
    )
  )
);

create policy "profiles update"
on public.app_profiles
for update
to authenticated
using (
  public.is_admin(auth.uid())
  or user_id = auth.uid()
)
with check (
  public.is_admin(auth.uid())
  or (
    user_id = auth.uid()
    and email = lower(coalesce(auth.jwt() ->> 'email', ''))
    and public.has_active_access(lower(coalesce(auth.jwt() ->> 'email', '')))
  )
);

create policy "profiles delete"
on public.app_profiles
for delete
to authenticated
using (public.is_admin(auth.uid()));

create policy "states select"
on public.user_states
for select
to authenticated
using (
  public.is_admin(auth.uid())
  or (
    auth.uid() = user_id
    and public.has_active_access(lower(coalesce(auth.jwt() ->> 'email', '')))
  )
);

create policy "states insert"
on public.user_states
for insert
to authenticated
with check (
  public.is_admin(auth.uid())
  or (
    auth.uid() = user_id
    and public.has_active_access(lower(coalesce(auth.jwt() ->> 'email', '')))
  )
);

create policy "states update"
on public.user_states
for update
to authenticated
using (
  public.is_admin(auth.uid())
  or (
    auth.uid() = user_id
    and public.has_active_access(lower(coalesce(auth.jwt() ->> 'email', '')))
  )
)
with check (
  public.is_admin(auth.uid())
  or (
    auth.uid() = user_id
    and public.has_active_access(lower(coalesce(auth.jwt() ->> 'email', '')))
  )
);

create policy "states delete"
on public.user_states
for delete
to authenticated
using (
  public.is_admin(auth.uid())
  or auth.uid() = user_id
);

insert into public.allowed_emails (
  email,
  full_name,
  role,
  status,
  valid_until,
  valid_until_at,
  temp_password,
  must_change_password,
  is_trial,
  created_at,
  updated_at
)
values (
  lower('daniielneves77@gmail.com'),
  'Administrador',
  'admin',
  'active',
  '2099-12-31',
  '2099-12-31T23:59:59Z',
  null,
  false,
  false,
  now(),
  now()
)
on conflict (email) do update
set
  full_name = excluded.full_name,
  role = 'admin',
  status = 'active',
  valid_until = '2099-12-31',
  valid_until_at = '2099-12-31T23:59:59Z',
  temp_password = null,
  must_change_password = false,
  is_trial = false,
  updated_at = now();

insert into public.app_profiles (
  user_id,
  email,
  full_name,
  role,
  status,
  valid_until,
  valid_until_at,
  is_trial,
  created_at,
  updated_at,
  last_login_at
)
select
  id,
  lower(email),
  'Administrador',
  'admin',
  'active',
  '2099-12-31',
  '2099-12-31T23:59:59Z',
  false,
  now(),
  now(),
  now()
from auth.users
where lower(email) = lower('daniielneves77@gmail.com')
on conflict (user_id) do update
set
  email = excluded.email,
  full_name = 'Administrador',
  role = 'admin',
  status = 'active',
  valid_until = '2099-12-31',
  valid_until_at = '2099-12-31T23:59:59Z',
  is_trial = false,
  updated_at = now(),
  last_login_at = now();

insert into public.user_states (user_id, app_state, updated_at)
select id, '{}'::jsonb, now()
from auth.users
where lower(email) = lower('daniielneves77@gmail.com')
on conflict (user_id) do nothing;

select 'allowed_emails' as tabela, email, role, status, valid_until
from public.allowed_emails
where email = lower('daniielneves77@gmail.com');

select 'app_profiles' as tabela, email, role, status, valid_until
from public.app_profiles
where email = lower('daniielneves77@gmail.com');

select 'user_states' as tabela, u.email, 'ok' as role, 'ok' as status, null::date as valid_until
from public.user_states s
join auth.users u on u.id = s.user_id
where lower(u.email) = lower('daniielneves77@gmail.com');
