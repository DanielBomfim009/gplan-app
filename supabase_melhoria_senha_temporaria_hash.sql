-- Melhoria de segurança para produção:
-- deixa de armazenar senha temporária em texto puro.
-- Rode este arquivo no SQL Editor do Supabase depois do schema atual.

create extension if not exists pgcrypto;

alter table public.allowed_emails
  add column if not exists temp_password_hash text;

update public.allowed_emails
set temp_password_hash = crypt(temp_password, gen_salt('bf')),
    temp_password = null,
    updated_at = now()
where coalesce(temp_password, '') <> ''
  and temp_password_hash is null;

create or replace function public.hash_allowed_email_temp_password()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.temp_password, '') <> '' then
    new.temp_password_hash := crypt(new.temp_password, gen_salt('bf'));
    new.temp_password := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_hash_allowed_email_temp_password on public.allowed_emails;
create trigger trg_hash_allowed_email_temp_password
before insert or update of temp_password on public.allowed_emails
for each row
execute function public.hash_allowed_email_temp_password();

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
    and (
      (a.temp_password_hash is not null and a.temp_password_hash = crypt(temp_password_value, a.temp_password_hash))
      or (a.temp_password_hash is null and coalesce(a.temp_password, '') = temp_password_value)
    )
    and a.status = 'active'
    and (
      (a.valid_until_at is not null and a.valid_until_at >= now())
      or (a.valid_until_at is null and (a.valid_until is null or a.valid_until >= current_date))
    )
  limit 1;
end;
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
    null::text as temp_password,
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
         temp_password_hash = null,
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

revoke all on function public.hash_allowed_email_temp_password() from public;
grant execute on function public.can_start_first_access(text, text) to anon, authenticated;
grant execute on function public.get_my_access_status() to authenticated;
grant execute on function public.mark_password_changed() to authenticated;
