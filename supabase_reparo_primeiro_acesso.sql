alter table public.allowed_emails
  add column if not exists valid_until_at timestamptz,
  add column if not exists is_trial boolean not null default false;

update public.allowed_emails
set valid_until_at = ((valid_until::text || ' 23:59:59')::timestamp at time zone 'America/Sao_Paulo')
where valid_until_at is null
  and valid_until is not null;

create sequence if not exists public.trial_account_number_seq
  as bigint
  start with 1
  increment by 1;

drop function if exists public.can_start_first_access(text, text);
drop function if exists public.next_trial_email();
drop function if exists public.admin_set_auth_ban(text, boolean);
drop function if exists public.admin_delete_access_account(text);

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

revoke all on function public.can_start_first_access(text, text) from public;
revoke all on function public.next_trial_email() from public;
revoke all on function public.admin_set_auth_ban(text, boolean) from public;
revoke all on function public.admin_delete_access_account(text) from public;
grant execute on function public.can_start_first_access(text, text) to anon, authenticated;
grant execute on function public.next_trial_email() to authenticated;
grant execute on function public.admin_set_auth_ban(text, boolean) to authenticated;
grant execute on function public.admin_delete_access_account(text) to authenticated;
