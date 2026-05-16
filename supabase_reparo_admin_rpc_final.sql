-- Reparo final do painel administrador.
-- Objetivo: corrigir falhas ao criar perfil teste e acesso comum.
-- Rode este arquivo no SQL Editor do Supabase depois dos SQLs anteriores.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.allowed_emails
  add column if not exists valid_until_at timestamptz,
  add column if not exists temp_password_hash text,
  add column if not exists plan_type text not null default 'manual'
    check (plan_type in ('manual', 'trial', 'monthly', 'semiannual', 'annual')),
  add column if not exists purchase_platform text,
  add column if not exists purchase_reference text,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists subscription_updated_at timestamptz;

alter table public.app_profiles
  add column if not exists valid_until_at timestamptz,
  add column if not exists plan_type text not null default 'manual'
    check (plan_type in ('manual', 'trial', 'monthly', 'semiannual', 'annual')),
  add column if not exists purchase_platform text,
  add column if not exists purchase_reference text,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists subscription_updated_at timestamptz;

create sequence if not exists public.trial_account_number_seq
  as bigint
  start with 1
  increment by 1;

create index if not exists allowed_emails_status_validity_idx
  on public.allowed_emails (status, valid_until_at);

create index if not exists allowed_emails_role_status_idx
  on public.allowed_emails (role, status);

create index if not exists allowed_emails_plan_idx
  on public.allowed_emails (plan_type);

create index if not exists app_profiles_email_idx
  on public.app_profiles (email);

drop function if exists public.admin_create_managed_access(text, text, text, text, timestamptz, text, text, text);
drop function if exists public.admin_create_trial_access(text, text, integer);
drop function if exists public.admin_list_accesses();
drop function if exists public.get_my_access_status();

create or replace function public.hash_allowed_email_temp_password()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.temp_password, '') <> '' then
    new.temp_password_hash := extensions.crypt(new.temp_password, extensions.gen_salt('bf'));
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

create or replace function public.normalize_plan_type(selected_plan text)
returns text
language sql
stable
as $$
  select case lower(trim(coalesce(selected_plan, 'monthly')))
    when 'trial' then 'trial'
    when 'monthly' then 'monthly'
    when 'semiannual' then 'semiannual'
    when 'annual' then 'annual'
    when 'manual' then 'manual'
    else 'monthly'
  end;
$$;

create or replace function public.get_plan_expiry(base_date timestamptz, selected_plan text)
returns timestamptz
language sql
stable
as $$
  select case public.normalize_plan_type(selected_plan)
    when 'trial' then base_date + interval '30 minutes'
    when 'monthly' then base_date + interval '30 days'
    when 'semiannual' then base_date + interval '6 months'
    when 'annual' then base_date + interval '12 months'
    else base_date + interval '30 days'
  end;
$$;

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select uid is not null
    and (
      exists (
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
      )
      or exists (
        select 1
        from public.app_profiles p
        where p.user_id = uid
          and p.role = 'admin'
          and p.status = 'active'
          and (
            (p.valid_until_at is not null and p.valid_until_at >= now())
            or (p.valid_until_at is null and (p.valid_until is null or p.valid_until >= current_date))
          )
      )
    );
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
    and (
      (a.temp_password_hash is not null and a.temp_password_hash = extensions.crypt(temp_password_value, a.temp_password_hash))
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
  plan_type text,
  purchase_platform text,
  purchase_reference text,
  subscription_started_at timestamptz,
  subscription_updated_at timestamptz,
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
      'manual'::text,
      null::text,
      null::text,
      null::timestamptz,
      null::timestamptz,
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
    coalesce(a.plan_type, 'manual') as plan_type,
    a.purchase_platform,
    a.purchase_reference,
    a.subscription_started_at,
    a.subscription_updated_at,
    a.account_created_at,
    a.claimed_at,
    case
      when a.email is null then 'missing'
      when a.status = 'blocked' then 'blocked'
      when a.valid_until_at is not null and a.valid_until_at < now() then 'expired'
      when a.valid_until_at is null and a.valid_until is not null and a.valid_until < current_date then 'expired'
      else 'active'
    end as effective_status
  from (select current_email as current_email_value) e
  left join public.allowed_emails a on a.email = e.current_email_value;
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
   where public.allowed_emails.email = current_email;

  if not found then
    raise exception 'Acesso administrado nao encontrado para este e-mail.';
  end if;

  update public.app_profiles
     set last_login_at = now(),
         updated_at = now()
   where public.app_profiles.email = current_email;
end;
$$;

create or replace function public.admin_create_managed_access(
  target_email text,
  target_full_name text,
  target_role text,
  selected_plan text,
  selected_valid_until_at timestamptz,
  temp_password_value text,
  selected_platform text default 'manual',
  selected_reference text default null
)
returns table (
  email text,
  full_name text,
  role text,
  status text,
  plan_type text,
  valid_until date,
  valid_until_at timestamptz,
  is_trial boolean,
  must_change_password boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text;
  normalized_role text;
  normalized_plan text;
  expires_at timestamptz;
  cleaned_name text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Sua sessão não tem permissão de administrador ativa no Supabase.';
  end if;

  normalized_email := lower(trim(coalesce(target_email, '')));
  normalized_role := lower(trim(coalesce(target_role, 'user')));
  normalized_plan := public.normalize_plan_type(selected_plan);
  expires_at := coalesce(selected_valid_until_at, public.get_plan_expiry(now(), normalized_plan));
  cleaned_name := nullif(trim(coalesce(target_full_name, '')), '');

  if normalized_email = '' or normalized_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'Informe um e-mail válido.';
  end if;

  if normalized_role not in ('admin', 'user') then
    raise exception 'Tipo de conta inválido.';
  end if;

  if coalesce(temp_password_value, '') = '' then
    raise exception 'Senha temporária inválida.';
  end if;

  insert into public.allowed_emails (
    email,
    full_name,
    role,
    status,
    valid_until,
    valid_until_at,
    temp_password,
    temp_password_hash,
    must_change_password,
    is_trial,
    plan_type,
    purchase_platform,
    purchase_reference,
    subscription_started_at,
    subscription_updated_at,
    account_created_at,
    claimed_at,
    created_by,
    updated_at
  )
  values (
    normalized_email,
    cleaned_name,
    normalized_role,
    'active',
    expires_at::date,
    expires_at,
    temp_password_value,
    extensions.crypt(temp_password_value, extensions.gen_salt('bf')),
    true,
    false,
    normalized_plan,
    coalesce(nullif(trim(coalesce(selected_platform, '')), ''), 'manual'),
    nullif(trim(coalesce(selected_reference, '')), ''),
    now(),
    now(),
    null,
    null,
    auth.uid(),
    now()
  )
  on conflict on constraint allowed_emails_pkey do update
     set full_name = coalesce(excluded.full_name, public.allowed_emails.full_name),
         role = excluded.role,
         status = 'active',
         valid_until = excluded.valid_until,
         valid_until_at = excluded.valid_until_at,
         temp_password = excluded.temp_password,
         temp_password_hash = excluded.temp_password_hash,
         must_change_password = true,
         is_trial = false,
         plan_type = excluded.plan_type,
         purchase_platform = excluded.purchase_platform,
         purchase_reference = excluded.purchase_reference,
         subscription_started_at = coalesce(public.allowed_emails.subscription_started_at, now()),
         subscription_updated_at = now(),
         updated_at = now();

  update public.app_profiles p
     set full_name = coalesce(cleaned_name, p.full_name),
         role = normalized_role,
         status = 'active',
         valid_until = expires_at::date,
         valid_until_at = expires_at,
         is_trial = false,
         plan_type = normalized_plan,
         purchase_platform = coalesce(nullif(trim(coalesce(selected_platform, '')), ''), p.purchase_platform),
         purchase_reference = nullif(trim(coalesce(selected_reference, '')), ''),
         subscription_started_at = coalesce(p.subscription_started_at, now()),
         subscription_updated_at = now(),
         updated_at = now()
   where lower(p.email) = normalized_email;

  return query
  select
    a.email,
    a.full_name,
    a.role,
    a.status,
    coalesce(a.plan_type, 'manual') as plan_type,
    a.valid_until,
    a.valid_until_at,
    coalesce(a.is_trial, false) as is_trial,
    coalesce(a.must_change_password, false) as must_change_password
  from public.allowed_emails a
  where a.email = normalized_email;
end;
$$;

create or replace function public.admin_create_trial_access(
  target_full_name text,
  temp_password_value text,
  trial_minutes integer default 30
)
returns table (
  email text,
  full_name text,
  role text,
  status text,
  plan_type text,
  valid_until date,
  valid_until_at timestamptz,
  is_trial boolean,
  temp_password text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  next_number bigint;
  candidate_email text;
  expires_at timestamptz;
  cleaned_name text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Sua sessão não tem permissão de administrador ativa no Supabase.';
  end if;

  if coalesce(temp_password_value, '') = '' then
    raise exception 'Senha temporária inválida.';
  end if;

  cleaned_name := coalesce(nullif(trim(coalesce(target_full_name, '')), ''), 'Perfil Teste');

  loop
    next_number := nextval('public.trial_account_number_seq'::regclass);
    candidate_email := lower('teste' || lpad(next_number::text, 3, '0') || '@trial.controlefinanceiro.app');

    exit when not exists (select 1 from public.allowed_emails a where a.email = candidate_email)
      and not exists (select 1 from public.app_profiles p where lower(p.email) = candidate_email)
      and not exists (select 1 from auth.users u where lower(u.email) = candidate_email);
  end loop;

  expires_at := now() + (greatest(coalesce(trial_minutes, 30), 1) * interval '1 minute');

  insert into public.allowed_emails (
    email,
    full_name,
    role,
    status,
    valid_until,
    valid_until_at,
    temp_password,
    temp_password_hash,
    must_change_password,
    is_trial,
    plan_type,
    purchase_platform,
    subscription_started_at,
    subscription_updated_at,
    account_created_at,
    claimed_at,
    created_by,
    updated_at
  )
  values (
    candidate_email,
    cleaned_name,
    'user',
    'active',
    expires_at::date,
    expires_at,
    temp_password_value,
    extensions.crypt(temp_password_value, extensions.gen_salt('bf')),
    false,
    true,
    'trial',
    'manual',
    now(),
    now(),
    now(),
    null,
    auth.uid(),
    now()
  );

  return query
  select
    a.email,
    a.full_name,
    a.role,
    a.status,
    coalesce(a.plan_type, 'trial') as plan_type,
    a.valid_until,
    a.valid_until_at,
    coalesce(a.is_trial, true) as is_trial,
    temp_password_value::text as temp_password
  from public.allowed_emails a
  where a.email = candidate_email;
end;
$$;

create or replace function public.admin_list_accesses()
returns table (
  email text,
  full_name text,
  role text,
  status text,
  valid_until date,
  valid_until_at timestamptz,
  must_change_password boolean,
  is_trial boolean,
  plan_type text,
  purchase_platform text,
  purchase_reference text,
  subscription_started_at timestamptz,
  subscription_updated_at timestamptz,
  account_created_at timestamptz,
  claimed_at timestamptz,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  profile_user_id uuid,
  profile_full_name text,
  profile_last_login_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Sua sessão não tem permissão de administrador ativa no Supabase.';
  end if;

  return query
  select
    a.email,
    a.full_name,
    a.role,
    a.status,
    a.valid_until,
    a.valid_until_at,
    coalesce(a.must_change_password, false) as must_change_password,
    coalesce(a.is_trial, false) as is_trial,
    coalesce(a.plan_type, 'manual') as plan_type,
    a.purchase_platform,
    a.purchase_reference,
    a.subscription_started_at,
    a.subscription_updated_at,
    a.account_created_at,
    a.claimed_at,
    a.created_by,
    a.created_at,
    a.updated_at,
    p.user_id as profile_user_id,
    p.full_name as profile_full_name,
    p.last_login_at as profile_last_login_at
  from public.allowed_emails a
  left join public.app_profiles p on lower(p.email) = a.email
  order by a.created_at desc
  limit 500;
end;
$$;

revoke all on function public.normalize_plan_type(text) from public;
revoke all on function public.hash_allowed_email_temp_password() from public;
revoke all on function public.admin_create_managed_access(text, text, text, text, timestamptz, text, text, text) from public;
revoke all on function public.admin_create_trial_access(text, text, integer) from public;
revoke all on function public.admin_list_accesses() from public;

grant execute on function public.can_start_first_access(text, text) to anon, authenticated;
grant execute on function public.get_my_access_status() to authenticated;
grant execute on function public.mark_password_changed() to authenticated;
grant execute on function public.admin_create_managed_access(text, text, text, text, timestamptz, text, text, text) to authenticated;
grant execute on function public.admin_create_trial_access(text, text, integer) to authenticated;
grant execute on function public.admin_list_accesses() to authenticated;
