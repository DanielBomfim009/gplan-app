-- =====================================================================
--  Controle Financeiro v2.3  -  avisos em segundo plano (push)
--
--  ANTES DE RODAR: troque COLE_AQUI_O_SEGREDO (uma vez, lá embaixo na
--  parte 2) pelo GPLAN_PUSH_SEGREDO do arquivo segredos_push.local.txt,
--  o mesmo que você colou nos "Secrets" da função enviar-push.
--
--  Rode este arquivo UMA vez, inteiro, no SQL Editor. Pode rodar de novo.
--  O que ele faz:
--    1) tabela push_assinaturas (um aparelho = uma linha)
--    2) configuração (endereço da função + segredo)
--    3) enviar_push(): chama a função na nuvem sem travar a gravação
--    4) avisos automáticos: lançamentos (agrupados), metas, apagar tudo
--    5) testar_push(): botão "Testar aviso" do app
--    6) lembrete diário das contas vencendo (08:00 de Brasília)
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------
-- 1) Assinaturas de aviso (cada aparelho que ligou os avisos)
-- ---------------------------------------------------------------------
create table if not exists public.push_assinaturas (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  casa_id uuid not null references public.casas(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  aparelho text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_assinaturas_casa_idx on public.push_assinaturas (casa_id, user_id);

alter table public.push_assinaturas enable row level security;
revoke all on table public.push_assinaturas from anon;
grant select, insert, update, delete on table public.push_assinaturas to authenticated;

drop policy if exists "push: minhas assinaturas" on public.push_assinaturas;
create policy "push: minhas assinaturas" on public.push_assinaturas
for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid() and casa_id = public.minha_casa());

create or replace function public.carimbar_push()
returns trigger
language plpgsql
as $$
begin
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_carimbar_push on public.push_assinaturas;
create trigger trg_carimbar_push before insert or update on public.push_assinaturas
for each row execute function public.carimbar_push();

-- ---------------------------------------------------------------------
-- 2) Configuração: endereço da função e segredo (só as funções do banco leem)
-- ---------------------------------------------------------------------
create or replace function public.push_config()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'url', 'https://xnxudiyrumkncyoibefe.supabase.co/functions/v1/enviar-push',
    'segredo', 'COLE_AQUI_O_SEGREDO'
  );
$$;

revoke all on function public.push_config() from public, anon, authenticated;

-- Valor em reais no formato brasileiro (R$ 1.234,56)
create or replace function public.brl(v numeric)
returns text
language sql
immutable
as $$
  select 'R$ ' || replace(replace(replace(to_char(coalesce(v, 0), 'FM999G999G999G990D00'), ',', '#'), '.', ','), '#', '.');
$$;

-- ---------------------------------------------------------------------
-- 3) Envio: pede à função na nuvem, sem travar quem está gravando
-- ---------------------------------------------------------------------
create or replace function public.enviar_push(p_casa uuid, p_autor uuid, p_destino uuid, p_title text, p_body text, p_tag text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cfg jsonb := public.push_config();
begin
  if p_casa is null or coalesce(cfg->>'segredo', '') in ('', 'COLE_AQUI_O_SEGREDO') then
    return; -- ainda não configurado: segue a vida sem aviso
  end if;
  perform net.http_post(
    url := cfg->>'url',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-gplan-segredo', cfg->>'segredo'),
    body := jsonb_build_object(
      'casa_id', p_casa, 'autor', p_autor, 'destino', p_destino,
      'title', left(coalesce(p_title, ''), 80), 'body', left(coalesce(p_body, ''), 160),
      'tag', coalesce(p_tag, 'gplan'), 'url', './index.html'),
    timeout_milliseconds := 8000
  );
exception when others then
  raise warning 'enviar_push: %', sqlerrm; -- nunca derruba a gravação por causa do aviso
end;
$$;

revoke all on function public.enviar_push(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;

-- Primeiro nome de quem fez (ou "Alguém")
create or replace function public.primeiro_nome(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select nullif(split_part(trim(m.nome), ' ', 1), '') from public.membros m where m.user_id = p_user), 'Alguém');
$$;

revoke all on function public.primeiro_nome(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) Avisos automáticos
--    Lançamentos: um aviso por gravação (uma recorrência de 12 meses
--    vira UM aviso "lançou 12 lançamentos", não 12 avisos).
-- ---------------------------------------------------------------------
create or replace function public.avisar_lancamentos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
  r record;
  a record;
  autor uuid;
  quem text;
  tipo text;
  titulo text;
  corpo text;
begin
  if current_setting('gplan.silencio', true) = 'on' then return null; end if;

  if tg_op = 'INSERT' then
    select count(*) into n from novos;
    if n = 0 then return null; end if;
    select * into r from novos order by date, id limit 1;
  elsif tg_op = 'UPDATE' then
    select count(*) into n from novos;
    if n = 0 then return null; end if;
    select * into r from novos order by date, id limit 1;
    select * into a from antigos where id = r.id limit 1;
  else
    select count(*) into n from antigos;
    if n = 0 then return null; end if;
    select * into r from antigos order by date, id limit 1;
  end if;

  autor := coalesce(auth.uid(), r.updated_by, r.created_by);
  quem := public.primeiro_nome(autor);
  tipo := case when r.type = 'income' then 'uma receita' else 'uma despesa' end;

  if n > 1 then
    titulo := quem || case tg_op when 'INSERT' then ' lançou ' when 'DELETE' then ' excluiu ' else ' alterou ' end || n || ' lançamentos';
    corpo := r.description || ' e outros';
  elsif tg_op = 'INSERT' then
    titulo := quem || ' lançou ' || tipo;
    corpo := r.description || ' · ' || public.brl(r.amount) || ' · ' || to_char(coalesce(r.data_pagamento, r.date), 'DD/MM');
  elsif tg_op = 'DELETE' then
    titulo := quem || ' excluiu ' || tipo;
    corpo := r.description || ' · ' || public.brl(r.amount);
  elsif a.status is distinct from r.status then
    titulo := quem || case when r.status = 'paid' then (case when r.type = 'income' then ' recebeu' else ' pagou' end) else ' reabriu' end;
    corpo := r.description || ' · ' || public.brl(r.amount);
  else
    titulo := quem || ' alterou ' || tipo;
    corpo := r.description || ' · ' || public.brl(r.amount) || ' · ' || to_char(coalesce(r.data_pagamento, r.date), 'DD/MM');
  end if;

  perform public.enviar_push(r.casa_id, autor, null, titulo, corpo, case when n > 1 then 'lanc-varios' else 'lanc-' || r.id end);
  return null;
end;
$$;

drop trigger if exists trg_avisar_lanc_ins on public.lancamentos;
create trigger trg_avisar_lanc_ins after insert on public.lancamentos
referencing new table as novos for each statement execute function public.avisar_lancamentos();

drop trigger if exists trg_avisar_lanc_upd on public.lancamentos;
create trigger trg_avisar_lanc_upd after update on public.lancamentos
referencing old table as antigos new table as novos for each statement execute function public.avisar_lancamentos();

drop trigger if exists trg_avisar_lanc_del on public.lancamentos;
create trigger trg_avisar_lanc_del after delete on public.lancamentos
referencing old table as antigos for each statement execute function public.avisar_lancamentos();

-- Metas: um aviso por meta mexida
create or replace function public.avisar_metas()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  autor uuid;
  titulo text;
begin
  if current_setting('gplan.silencio', true) = 'on' then return null; end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  autor := coalesce(auth.uid(), r.updated_by, r.created_by);
  titulo := public.primeiro_nome(autor) || case tg_op when 'INSERT' then ' criou a meta ' when 'DELETE' then ' excluiu a meta ' else ' atualizou a meta ' end || r.title;
  perform public.enviar_push(r.casa_id, autor, null, titulo, public.brl(r.current) || ' de ' || public.brl(r.target), 'meta-' || r.id);
  return null;
end;
$$;

drop trigger if exists trg_avisar_metas on public.metas;
create trigger trg_avisar_metas after insert or update or delete on public.metas
for each row execute function public.avisar_metas();

-- Apagar tudo (mesma função do SQL 2.1, agora avisando a casa no fim)
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

  perform set_config('gplan.silencio', 'on', true);
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

  perform public.enviar_push(casa, auth.uid(), null,
    public.primeiro_nome(auth.uid()) || ' apagou todos os dados da casa',
    format('%s lançamentos e %s metas foram apagados.', n_l, n_m), 'apagou-tudo');

  return jsonb_build_object('lancamentos', n_l, 'metas', n_m, 'orcamentos', n_o);
end;
$$;

revoke all on function public.apagar_tudo_da_casa() from public;
grant execute on function public.apagar_tudo_da_casa() to authenticated;

-- ---------------------------------------------------------------------
-- 5) Botão "Testar aviso": manda um aviso só para quem apertou
-- ---------------------------------------------------------------------
create or replace function public.testar_push()
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(public.push_config()->>'segredo', '') in ('', 'COLE_AQUI_O_SEGREDO') then
    return 'O segredo ainda não foi preenchido no SQL 2.3.';
  end if;
  if not exists (select 1 from public.push_assinaturas where user_id = auth.uid()) then
    return 'Este aparelho ainda não está cadastrado. Desligue e ligue os avisos de novo.';
  end if;
  perform public.enviar_push(public.minha_casa(), null, auth.uid(),
    'Teste de aviso', 'Se você está vendo isto, os avisos em segundo plano funcionam neste aparelho.',
    'teste-' || extract(epoch from now())::bigint);
  return 'Pedido enviado. O aviso deve chegar em alguns segundos, mesmo com o app fechado.';
end;
$$;

revoke all on function public.testar_push() from public;
grant execute on function public.testar_push() to authenticated;

-- ---------------------------------------------------------------------
-- 6) Lembrete diário: contas para pagar hoje ou atrasadas (08:00 Brasília)
-- ---------------------------------------------------------------------
create or replace function public.lembrar_vencimentos()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
begin
  for c in
    select l.casa_id,
           count(*) as n,
           sum(l.amount) as total,
           count(*) filter (where coalesce(l.data_pagamento, l.date) < current_date) as atrasadas
      from public.lancamentos l
     where l.type = 'expense' and l.status = 'pending'
       and coalesce(l.data_pagamento, l.date) <= current_date
     group by l.casa_id
  loop
    perform public.enviar_push(c.casa_id, null, null,
      case when c.n = 1 then '1 conta para pagar hoje ou atrasada' else c.n || ' contas para pagar hoje ou atrasadas' end,
      public.brl(c.total) || ' no total' || case when c.atrasadas > 0 then ' · ' || c.atrasadas || ' já ' || case when c.atrasadas = 1 then 'passou' else 'passaram' end || ' da data' else '' end,
      'lembrete-' || to_char(current_date, 'YYYYMMDD'));
  end loop;
end;
$$;

revoke all on function public.lembrar_vencimentos() from public, anon, authenticated;

do $$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    begin
      create extension if not exists pg_cron;
    exception when others then
      raise notice 'pg_cron não disponível por SQL (%). Ative em Database > Extensions > pg_cron e rode este arquivo de novo.', sqlerrm;
    end;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'gplan-lembrete-vencimentos') then
      perform cron.unschedule('gplan-lembrete-vencimentos');
    end if;
    perform cron.schedule('gplan-lembrete-vencimentos', '0 11 * * *', 'select public.lembrar_vencimentos()'); -- 11:00 UTC = 08:00 Brasília
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 7) Conferência (só mostra, não altera)
-- ---------------------------------------------------------------------
create or replace function public.avisos_status()
returns table(item text, valor text)
language plpgsql
security definer
set search_path = public
as $$
declare
  agendado boolean := false;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute 'select exists (select 1 from cron.job where jobname = ''gplan-lembrete-vencimentos'')' into agendado;
  end if;
  return query select 'segredo preenchido'::text,
    case when coalesce(public.push_config()->>'segredo', '') in ('', 'COLE_AQUI_O_SEGREDO')
         then 'NÃO: troque COLE_AQUI_O_SEGREDO e rode de novo'::text else 'ok'::text end;
  return query select 'pg_net'::text, case when exists (select 1 from pg_extension where extname = 'pg_net') then 'ok'::text else 'FALTA'::text end;
  return query select 'aparelhos cadastrados'::text, count(*)::text from public.push_assinaturas;
  return query select 'lembrete diário'::text, case when agendado then 'agendado 08:00'::text else 'não agendado (ative pg_cron em Database > Extensions)'::text end;
end;
$$;

revoke all on function public.avisos_status() from public, anon, authenticated;

select * from public.avisos_status();
