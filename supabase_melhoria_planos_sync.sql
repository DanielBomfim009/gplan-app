-- Complemento dos planos:
-- garante que os campos comerciais sejam sincronizados entre allowed_emails e app_profiles.
-- Rode no SQL Editor do Supabase depois de supabase_melhoria_capacidade_300.sql.

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
  new.plan_type := coalesce(access_row.plan_type, 'manual');
  new.purchase_platform := access_row.purchase_platform;
  new.purchase_reference := access_row.purchase_reference;
  new.subscription_started_at := access_row.subscription_started_at;
  new.subscription_updated_at := access_row.subscription_updated_at;
  new.full_name := coalesce(nullif(new.full_name, ''), access_row.full_name, new.full_name);
  new.updated_at := now();

  return new;
end;
$$;

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
         plan_type = coalesce(new.plan_type, 'manual'),
         purchase_platform = new.purchase_platform,
         purchase_reference = new.purchase_reference,
         subscription_started_at = new.subscription_started_at,
         subscription_updated_at = new.subscription_updated_at,
         updated_at = now()
   where email = lower(new.email);

  return new;
end;
$$;
