-- =====================================================================
--  Controle Financeiro v2.1  -  administração da casa
--  Rode este arquivo UMA vez, inteiro, no SQL Editor do Supabase,
--  DEPOIS do supabase_v2.sql. Pode rodar de novo sem estragar nada.
--  Acrescenta: papel de administrador, convites por e-mail (a outra
--  pessoa cria a conta pelo próprio app), histórico de atividade e
--  "apagar tudo da casa".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Papel de cada membro: admin ou membro.
--    O membro mais antigo de cada casa vira administrador se a casa
--    ainda não tiver um.
-- ---------------------------------------------------------------------
alter table public.membros add column if not exists papel text not null default 'membro';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'membros_papel_check') then
    alter table public.membros add constraint membros_papel_check check (papel in ('admin', 'membro'));
  end if;
end;
$$;

update public.membros m
   set papel = 'admin'
 where not exists (select 1 from public.membros a where a.casa_id = m.casa_id and a.papel = 'admin')
   and m.user_id = (
     select m2.user_id from public.membros m2
      where m2.casa_id = m.casa_id
      order by m2.created_at, m2.user_id
      limit 1
   );

create or replace function public.sou_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.membros m where m.user_id = auth.uid() and m.papel = 'admin');
$$;

revoke all on function public.sou_admin() from public;
grant execute on function public.sou_admin() to authenticated;

-- Ninguém troca o próprio papel nem a própria casa pela API; só o
-- administrador muda o papel dos outros.
create or replace function public.proteger_membro()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sou_admin() then
    new.papel := old.papel;
    new.casa_id := old.casa_id;
  end if;
  new.user_id := old.user_id;
  return new;
end;
$$;

drop trigger if exists trg_proteger_membro on public.membros;
create trigger trg_proteger_membro before update on public.membros
for each row execute function public.proteger_membro();

-- ---------------------------------------------------------------------
-- 2) Convites por e-mail: o administrador registra o e-mail; a pessoa
--    cria a conta no app com esse e-mail e entra na casa sozinha.
-- ---------------------------------------------------------------------
create table if not exists public.convites (
  email text primary key,
  casa_id uuid not null references public.casas(id) on delete cascade,
  criado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  usado_por uuid references auth.users(id) on delete set null,
  usado_em timestamptz
);

alter table public.convites enable row level security;
revoke all on table public.convites from anon;
grant select, insert, update, delete on table public.convites to authenticated;

drop policy if exists "convites: admin da casa" on public.convites;
create policy "convites: admin da casa" on public.convites
for all to authenticated
using (casa_id = public.minha_casa() and public.sou_admin())
with check (casa_id = public.minha_casa() and public.sou_admin());

create or replace function public.carimbar_convite()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  if tg_op = 'INSERT' then
    new.criado_por := coalesce(auth.uid(), new.criado_por);
    new.criado_em := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_carimbar_convite on public.convites;
create trigger trg_carimbar_convite before insert or update on public.convites
for each row execute function public.carimbar_convite();

-- ---------------------------------------------------------------------
-- 3) Quem entra na casa ao criar conta:
--    - e-mail convidado  -> entra na casa do convite, como membro;
--    - primeiro usuário de todos -> vira administrador da casa padrão;
--    - qualquer outro -> a criação da conta é recusada.
--    (Vale também para contas criadas no painel do Supabase: convide antes.)
-- ---------------------------------------------------------------------
create or replace function public.novo_membro()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conv public.convites%rowtype;
  nome_novo text;
begin
  nome_novo := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, 'usuario'), '@', 1)
  );

  select * into conv
    from public.convites c
   where c.email = lower(coalesce(new.email, ''))
     and c.usado_em is null
   limit 1;

  if found then
    insert into public.membros (user_id, casa_id, nome, papel)
    values (new.id, conv.casa_id, nome_novo, 'membro')
    on conflict (user_id) do nothing;
    update public.convites set usado_por = new.id, usado_em = now() where email = conv.email;
    return new;
  end if;

  if not exists (select 1 from public.membros) then
    insert into public.membros (user_id, casa_id, nome, papel)
    values (new.id, '00000000-0000-0000-0000-000000000001', nome_novo, 'admin')
    on conflict (user_id) do nothing;
    return new;
  end if;

  raise exception 'Este e-mail não foi convidado para a casa. Peça ao administrador para convidar.';
end;
$$;

-- ---------------------------------------------------------------------
-- 4) Histórico de atividade: quem lançou, pagou, alterou ou excluiu.
-- ---------------------------------------------------------------------
create table if not exists public.historico (
  id bigint generated by default as identity primary key,
  casa_id uuid not null references public.casas(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  acao text not null,
  tabela text not null,
  item_id text,
  descricao text,
  valor numeric(14, 2),
  criado_em timestamptz not null default now()
);

create index if not exists historico_casa_data_idx on public.historico (casa_id, criado_em desc);

alter table public.historico enable row level security;
revoke all on table public.historico from anon;
grant select on table public.historico to authenticated;

drop policy if exists "historico: casa" on public.historico;
create policy "historico: casa" on public.historico
for select to authenticated using (casa_id = public.minha_casa());

create or replace function public.registrar_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  acao_ text;
  desc_ text;
  val_ numeric;
  item_ text;
begin
  if current_setting('gplan.silencio', true) = 'on' then
    return null;
  end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  if tg_table_name = 'lancamentos' then
    item_ := r.id;
    desc_ := r.description;
    val_ := r.amount;
    if tg_op = 'INSERT' then
      acao_ := 'criou';
    elsif tg_op = 'DELETE' then
      acao_ := 'excluiu';
    elsif new.status is distinct from old.status then
      acao_ := case when new.status = 'paid' then 'pagou' else 'reabriu' end;
    else
      acao_ := 'alterou';
    end if;
  else
    item_ := r.id;
    desc_ := r.title;
    val_ := r.current;
    acao_ := case tg_op when 'INSERT' then 'criou meta' when 'DELETE' then 'excluiu meta' else 'alterou meta' end;
  end if;

  insert into public.historico (casa_id, user_id, acao, tabela, item_id, descricao, valor)
  values (r.casa_id, auth.uid(), acao_, tg_table_name, item_, left(coalesce(desc_, ''), 120), val_);

  -- De vez em quando, limpa o que tem mais de 180 dias.
  if random() < 0.01 then
    delete from public.historico h where h.casa_id = r.casa_id and h.criado_em < now() - interval '180 days';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_historico_lancamentos on public.lancamentos;
create trigger trg_historico_lancamentos after insert or update or delete on public.lancamentos
for each row execute function public.registrar_historico();

drop trigger if exists trg_historico_metas on public.metas;
create trigger trg_historico_metas after insert or update or delete on public.metas
for each row execute function public.registrar_historico();

-- ---------------------------------------------------------------------
-- 5) O administrador renomeia a casa, renomeia e remove membros.
-- ---------------------------------------------------------------------
grant update on table public.casas to authenticated;
grant delete on table public.membros to authenticated;

drop policy if exists "casa: admin renomeia" on public.casas;
create policy "casa: admin renomeia" on public.casas
for update to authenticated
using (id = public.minha_casa() and public.sou_admin())
with check (id = public.minha_casa());

drop policy if exists "membros: editar o meu" on public.membros;
create policy "membros: editar o meu" on public.membros
for update to authenticated
using (user_id = auth.uid() or (casa_id = public.minha_casa() and public.sou_admin()))
with check (casa_id = public.minha_casa());

drop policy if exists "membros: admin remove" on public.membros;
create policy "membros: admin remove" on public.membros
for delete to authenticated
using (casa_id = public.minha_casa() and public.sou_admin() and user_id <> auth.uid());

-- ---------------------------------------------------------------------
-- 6) Apagar tudo da casa (só o administrador). Contas e pessoas ficam.
-- ---------------------------------------------------------------------
create or replace function public.apagar_tudo_da_casa()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  casa uuid;
  n_l integer;
  n_m integer;
  n_o integer;
begin
  if not public.sou_admin() then
    raise exception 'Só o administrador da casa pode apagar tudo.';
  end if;
  casa := public.minha_casa();
  if casa is null then
    raise exception 'Sua conta não está em nenhuma casa.';
  end if;

  perform set_config('gplan.silencio', 'on', true); -- não registra milhares de linhas no histórico
  delete from public.lancamentos where casa_id = casa;
  get diagnostics n_l = row_count;
  delete from public.metas where casa_id = casa;
  get diagnostics n_m = row_count;
  delete from public.orcamentos where casa_id = casa;
  get diagnostics n_o = row_count;
  perform set_config('gplan.silencio', 'off', true);

  delete from public.historico where casa_id = casa;
  insert into public.historico (casa_id, user_id, acao, tabela, descricao)
  values (casa, auth.uid(), 'apagou tudo', 'casa', format('%s lançamentos, %s metas', n_l, n_m));

  return jsonb_build_object('lancamentos', n_l, 'metas', n_m, 'orcamentos', n_o);
end;
$$;

revoke all on function public.apagar_tudo_da_casa() from public;
grant execute on function public.apagar_tudo_da_casa() to authenticated;

-- ---------------------------------------------------------------------
-- 7) Tempo real também para o histórico
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'historico'
  ) then
    alter publication supabase_realtime add table public.historico;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 8) Conferência final (só mostra, não altera)
-- ---------------------------------------------------------------------
select 'administradores' as item, count(*)::text as valor from public.membros where papel = 'admin'
union all
select 'membros comuns', count(*)::text from public.membros where papel = 'membro'
union all
select 'convites pendentes', count(*)::text from public.convites where usado_em is null
union all
select 'historico', count(*)::text from public.historico
union all
select 'tempo real', coalesce(string_agg(tablename, ', ' order by tablename), 'nenhuma')
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public';
