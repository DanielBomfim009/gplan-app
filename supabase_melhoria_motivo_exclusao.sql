-- Melhoria: motivo de exclusao de cadastro.
-- Rode este SQL uma vez no Supabase SQL Editor.
-- Objetivo: quando o administrador excluir um cadastro, salvar o motivo
-- e permitir que o cliente veja esse motivo ao tentar acessar novamente.

create schema if not exists extensions;
set search_path = public, extensions;

create table if not exists public.access_deletion_notices (
  email text primary key,
  reason text not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now()
);

alter table public.access_deletion_notices enable row level security;

create index if not exists idx_access_deletion_notices_deleted_at
  on public.access_deletion_notices (deleted_at desc);

create or replace function public.get_access_deletion_notice(user_email text)
returns table (
  email text,
  reason text,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
stable
as $$
declare
  normalized_email text;
begin
  normalized_email := lower(trim(coalesce(user_email, '')));

  if normalized_email = '' then
    return;
  end if;

  return query
  select n.email, n.reason, n.deleted_at
    from public.access_deletion_notices n
   where n.email = normalized_email
   limit 1;
end;
$$;

drop function if exists public.admin_delete_access_account(text);
drop function if exists public.admin_delete_access_account(text, text);

create or replace function public.admin_delete_access_account(
  target_email text,
  deletion_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_email text;
  target_user_id uuid;
  cleaned_reason text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Somente administradores podem excluir acessos.';
  end if;

  normalized_email := lower(trim(coalesce(target_email, '')));
  cleaned_reason := left(trim(coalesce(deletion_reason, '')), 240);

  if normalized_email = '' then
    raise exception 'E-mail invalido.';
  end if;

  if cleaned_reason = '' or length(cleaned_reason) < 8 then
    raise exception 'Informe o motivo da exclusao com pelo menos 8 caracteres.';
  end if;

  if normalized_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Nao exclua a propria conta administradora por aqui.';
  end if;

  insert into public.access_deletion_notices (
    email,
    reason,
    deleted_by,
    deleted_at
  )
  values (
    normalized_email,
    cleaned_reason,
    auth.uid(),
    now()
  )
  on conflict (email) do update
     set reason = excluded.reason,
         deleted_by = excluded.deleted_by,
         deleted_at = excluded.deleted_at;

  select u.id
    into target_user_id
  from auth.users u
  where lower(u.email) = normalized_email
  limit 1;

  if target_user_id is not null then
    delete from public.user_states s where s.user_id = target_user_id;
    delete from public.app_profiles p where p.user_id = target_user_id;
    delete from auth.users u where u.id = target_user_id;
  end if;

  delete from public.app_profiles p where lower(p.email) = normalized_email;
  delete from public.allowed_emails a where a.email = normalized_email;

  return true;
end;
$$;

create or replace function public.clear_access_deletion_notice_on_allow()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status = 'active' then
    delete from public.access_deletion_notices n
     where n.email = lower(trim(new.email));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clear_access_deletion_notice_on_allow on public.allowed_emails;
create trigger trg_clear_access_deletion_notice_on_allow
after insert or update of status on public.allowed_emails
for each row
execute function public.clear_access_deletion_notice_on_allow();

revoke all on function public.get_access_deletion_notice(text) from public;
revoke all on function public.admin_delete_access_account(text, text) from public;
revoke all on function public.clear_access_deletion_notice_on_allow() from public;

grant execute on function public.get_access_deletion_notice(text) to anon, authenticated;
grant execute on function public.admin_delete_access_account(text, text) to authenticated;
