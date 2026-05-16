-- Diagnostico seguro da Prioridade 1 - Confiabilidade.
-- Este arquivo nao altera dados. Rode no SQL Editor do Supabase.

select
  'extensions.pgcrypto' as item,
  case when exists (
    select 1
    from pg_extension
    where extname = 'pgcrypto'
  ) then 'ok' else 'faltando' end as status;

select
  'tabelas principais' as item,
  jsonb_build_object(
    'user_states', to_regclass('public.user_states') is not null,
    'allowed_emails', to_regclass('public.allowed_emails') is not null,
    'app_profiles', to_regclass('public.app_profiles') is not null
  ) as status;

select
  'colunas allowed_emails' as item,
  jsonb_object_agg(column_name, true order by column_name) as colunas
from information_schema.columns
where table_schema = 'public'
  and table_name = 'allowed_emails'
  and column_name in (
    'email',
    'full_name',
    'role',
    'status',
    'valid_until',
    'valid_until_at',
    'temp_password',
    'temp_password_hash',
    'must_change_password',
    'is_trial',
    'plan_type',
    'purchase_platform',
    'purchase_reference',
    'subscription_started_at',
    'subscription_updated_at',
    'account_created_at',
    'claimed_at',
    'created_by',
    'created_at',
    'updated_at'
  );

select
  'colunas app_profiles' as item,
  jsonb_object_agg(column_name, true order by column_name) as colunas
from information_schema.columns
where table_schema = 'public'
  and table_name = 'app_profiles'
  and column_name in (
    'user_id',
    'email',
    'full_name',
    'role',
    'status',
    'valid_until',
    'valid_until_at',
    'is_trial',
    'plan_type',
    'purchase_platform',
    'purchase_reference',
    'subscription_started_at',
    'subscription_updated_at',
    'created_by',
    'created_at',
    'updated_at',
    'last_login_at'
  );

select
  'funcoes RPC usadas pelo app' as item,
  jsonb_object_agg(required_function, exists_in_database order by required_function) as status
from (
  select
    required_function,
    exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = required_function
    ) as exists_in_database
  from unnest(array[
    'can_start_first_access',
    'next_trial_email',
    'get_my_access_status',
    'admin_set_auth_ban',
    'admin_delete_access_account',
    'admin_create_managed_access',
    'admin_create_trial_access',
    'admin_list_accesses',
    'admin_apply_access_plan',
    'mark_password_changed',
    'is_admin',
    'has_active_access',
    'has_any_admin'
  ]) as required_function
) checks;

select
  'resumo allowed_emails' as item,
  role,
  status,
  coalesce(plan_type, 'manual') as plan_type,
  count(*) as total
from public.allowed_emails
group by role, status, coalesce(plan_type, 'manual')
order by role, status, plan_type;

select
  'ultimos acessos cadastrados' as item,
  email,
  full_name,
  role,
  status,
  coalesce(plan_type, 'manual') as plan_type,
  valid_until_at,
  is_trial,
  must_change_password,
  created_at,
  updated_at
from public.allowed_emails
order by created_at desc
limit 20;

select
  'perfis criados' as item,
  email,
  full_name,
  role,
  status,
  coalesce(plan_type, 'manual') as plan_type,
  valid_until_at,
  is_trial,
  last_login_at,
  updated_at
from public.app_profiles
order by updated_at desc
limit 20;
