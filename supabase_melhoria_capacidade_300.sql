-- Melhoria para suportar pelo menos 300 usuários com mais folga operacional.
-- Rode no SQL Editor do Supabase depois de fazer backup do banco.
-- Este script adiciona campos comerciais, índices e uma função segura para renovar plano.

alter table public.allowed_emails
  add column if not exists plan_type text not null default 'manual'
    check (plan_type in ('manual', 'trial', 'monthly', 'semiannual', 'annual')),
  add column if not exists purchase_platform text,
  add column if not exists purchase_reference text,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists subscription_updated_at timestamptz;

alter table public.app_profiles
  add column if not exists plan_type text not null default 'manual'
    check (plan_type in ('manual', 'trial', 'monthly', 'semiannual', 'annual')),
  add column if not exists purchase_platform text,
  add column if not exists purchase_reference text,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists subscription_updated_at timestamptz;

create index if not exists allowed_emails_status_validity_idx
  on public.allowed_emails (status, valid_until_at);

create index if not exists allowed_emails_role_status_idx
  on public.allowed_emails (role, status);

create index if not exists allowed_emails_plan_idx
  on public.allowed_emails (plan_type);

create index if not exists allowed_emails_created_at_idx
  on public.allowed_emails (created_at desc);

create index if not exists app_profiles_status_validity_idx
  on public.app_profiles (status, valid_until_at);

create index if not exists app_profiles_plan_idx
  on public.app_profiles (plan_type);

create index if not exists app_profiles_created_at_idx
  on public.app_profiles (created_at desc);

create index if not exists app_profiles_last_login_idx
  on public.app_profiles (last_login_at desc);

create index if not exists user_states_updated_at_idx
  on public.user_states (updated_at desc);

create or replace function public.get_plan_expiry(base_date timestamptz, selected_plan text)
returns timestamptz
language sql
stable
as $$
  select case selected_plan
    when 'trial' then base_date + interval '30 minutes'
    when 'monthly' then base_date + interval '30 days'
    when 'semiannual' then base_date + interval '6 months'
    when 'annual' then base_date + interval '12 months'
    else base_date + interval '30 days'
  end;
$$;

create or replace function public.admin_apply_access_plan(
  target_email text,
  selected_plan text,
  selected_platform text default null,
  selected_reference text default null
)
returns table (
  email text,
  plan_type text,
  valid_until date,
  valid_until_at timestamptz,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text;
  normalized_plan text;
  base_date timestamptz;
  expires_at timestamptz;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem aplicar planos.';
  end if;

  normalized_email := lower(trim(coalesce(target_email, '')));
  normalized_plan := lower(trim(coalesce(selected_plan, 'monthly')));

  if normalized_email = '' then
    raise exception 'E-mail inválido.';
  end if;

  if normalized_plan not in ('trial', 'monthly', 'semiannual', 'annual') then
    raise exception 'Plano inválido.';
  end if;

  select greatest(coalesce(a.valid_until_at, now()), now())
    into base_date
  from public.allowed_emails a
  where a.email = normalized_email;

  base_date := coalesce(base_date, now());
  expires_at := public.get_plan_expiry(base_date, normalized_plan);

  update public.allowed_emails
     set plan_type = normalized_plan,
         purchase_platform = nullif(trim(coalesce(selected_platform, '')), ''),
         purchase_reference = nullif(trim(coalesce(selected_reference, '')), ''),
         subscription_started_at = coalesce(subscription_started_at, now()),
         subscription_updated_at = now(),
         valid_until = expires_at::date,
         valid_until_at = expires_at,
         status = 'active',
         updated_at = now()
   where public.allowed_emails.email = normalized_email;

  if not found then
    raise exception 'Acesso não encontrado para este e-mail.';
  end if;

  update public.app_profiles
     set plan_type = normalized_plan,
         purchase_platform = nullif(trim(coalesce(selected_platform, '')), ''),
         purchase_reference = nullif(trim(coalesce(selected_reference, '')), ''),
         subscription_started_at = coalesce(subscription_started_at, now()),
         subscription_updated_at = now(),
         valid_until = expires_at::date,
         valid_until_at = expires_at,
         status = 'active',
         updated_at = now()
   where public.app_profiles.email = normalized_email;

  return query
  select
    a.email,
    a.plan_type,
    a.valid_until,
    a.valid_until_at,
    a.status
  from public.allowed_emails a
  where a.email = normalized_email;
end;
$$;

revoke all on function public.get_plan_expiry(timestamptz, text) from public;
revoke all on function public.admin_apply_access_plan(text, text, text, text) from public;
grant execute on function public.admin_apply_access_plan(text, text, text, text) to authenticated;
