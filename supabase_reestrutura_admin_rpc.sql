-- Reestruturação do painel administrador.
-- Objetivo: centralizar criação manual, perfil teste e listagem em RPCs seguras.
-- Rode este arquivo no SQL Editor do Supabase depois dos SQLs anteriores.

create extension if not exists pgcrypto;

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
    else 'monthly'
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
  admin_email text;
  target_user_id uuid;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem criar acessos.';
  end if;

  normalized_email := lower(trim(coalesce(target_email, '')));
  normalized_role := lower(trim(coalesce(target_role, 'user')));
  normalized_plan := public.normalize_plan_type(selected_plan);
  expires_at := coalesce(selected_valid_until_at, public.get_plan_expiry(now(), normalized_plan));
  admin_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  if normalized_email = '' then
    raise exception 'E-mail inválido.';
  end if;

  if normalized_role not in ('admin', 'user') then
    raise exception 'Tipo de conta inválido.';
  end if;

  if coalesce(temp_password_value, '') = '' then
    raise exception 'Senha temporária inválida.';
  end if;

  if normalized_email <> admin_email then
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

    delete from public.app_profiles p where lower(p.email) = normalized_email;
  end if;

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
    nullif(trim(coalesce(target_full_name, '')), ''),
    normalized_role,
    'active',
    expires_at::date,
    expires_at,
    temp_password_value,
    true,
    false,
    normalized_plan,
    nullif(trim(coalesce(selected_platform, 'manual')), ''),
    nullif(trim(coalesce(selected_reference, '')), ''),
    coalesce((select a.subscription_started_at from public.allowed_emails a where a.email = normalized_email), now()),
    now(),
    null,
    null,
    auth.uid(),
    now()
  )
  on conflict (email) do update
     set full_name = excluded.full_name,
         role = excluded.role,
         status = 'active',
         valid_until = excluded.valid_until,
         valid_until_at = excluded.valid_until_at,
         temp_password = temp_password_value,
         temp_password_hash = crypt(temp_password_value, gen_salt('bf')),
         must_change_password = true,
         is_trial = false,
         plan_type = excluded.plan_type,
         purchase_platform = excluded.purchase_platform,
         purchase_reference = excluded.purchase_reference,
         subscription_started_at = coalesce(public.allowed_emails.subscription_started_at, now()),
         subscription_updated_at = now(),
         updated_at = now();

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
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem gerar perfil teste.';
  end if;

  if coalesce(temp_password_value, '') = '' then
    raise exception 'Senha temporária inválida.';
  end if;

  loop
    next_number := nextval('public.trial_account_number_seq'::regclass);
    candidate_email := lower('teste' || lpad(next_number::text, 3, '0') || '@trial.controlefinanceiro.app');

    exit when not exists (select 1 from public.allowed_emails a where a.email = candidate_email)
      and not exists (select 1 from public.app_profiles p where p.email = candidate_email)
      and not exists (select 1 from auth.users u where lower(u.email) = candidate_email);
  end loop;

  expires_at := now() + make_interval(mins => greatest(coalesce(trial_minutes, 30), 1));

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
    coalesce(nullif(trim(coalesce(target_full_name, '')), ''), 'Perfil Teste'),
    'user',
    'active',
    expires_at::date,
    expires_at,
    temp_password_value,
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
    raise exception 'Somente administradores podem listar acessos.';
  end if;

  return query
  select
    a.email,
    a.full_name,
    a.role,
    a.status,
    a.valid_until,
    a.valid_until_at,
    coalesce(a.must_change_password, false),
    coalesce(a.is_trial, false),
    coalesce(a.plan_type, 'manual'),
    a.purchase_platform,
    a.purchase_reference,
    a.subscription_started_at,
    a.subscription_updated_at,
    a.account_created_at,
    a.claimed_at,
    a.created_by,
    a.created_at,
    a.updated_at,
    p.user_id,
    p.full_name,
    p.last_login_at
  from public.allowed_emails a
  left join public.app_profiles p on p.email = a.email
  order by a.created_at desc
  limit 500;
end;
$$;

revoke all on function public.normalize_plan_type(text) from public;
revoke all on function public.admin_create_managed_access(text, text, text, text, timestamptz, text, text, text) from public;
revoke all on function public.admin_create_trial_access(text, text, integer) from public;
revoke all on function public.admin_list_accesses() from public;

grant execute on function public.admin_create_managed_access(text, text, text, text, timestamptz, text, text, text) to authenticated;
grant execute on function public.admin_create_trial_access(text, text, integer) to authenticated;
grant execute on function public.admin_list_accesses() to authenticated;
