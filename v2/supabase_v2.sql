-- =====================================================================
--  Controle Financeiro v2  -  banco para uso pessoal (duas pessoas)
--  Rode este arquivo UMA vez, inteiro, no SQL Editor do Supabase.
--  Ele cria as tabelas, as regras de acesso, o tempo real e as
--  contas padrão. Pode ser rodado de novo sem estragar nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) A "casa": o grupo que compartilha os dados (vocês dois).
-- ---------------------------------------------------------------------
create table if not exists public.casas (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Nossa casa',
  created_at timestamptz not null default now()
);

insert into public.casas (id, nome)
values ('00000000-0000-0000-0000-000000000001', 'Nossa casa')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2) Membros: cada pessoa logada pertence à casa.
--    Todo usuário criado em Authentication > Users entra na casa
--    automaticamente (gatilho mais abaixo).
-- ---------------------------------------------------------------------
create table if not exists public.membros (
  user_id uuid primary key references auth.users(id) on delete cascade,
  casa_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references public.casas(id) on delete cascade,
  nome text not null,
  cor text not null default '#00b4a0',
  foto text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3) Lançamentos: UMA linha por receita/despesa (antes era um JSON só).
--    type = income | expense ; status = pending | paid (códigos do app).
-- ---------------------------------------------------------------------
create table if not exists public.lancamentos (
  id text primary key,
  casa_id uuid not null references public.casas(id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount numeric(14, 2) not null default 0,
  description text not null default '',
  date date not null,
  category text not null default 'other',
  account_id text,
  payment_method text,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  recurring boolean not null default false,
  recurring_id text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lancamentos_casa_data_idx on public.lancamentos (casa_id, date desc);
create index if not exists lancamentos_casa_recorrencia_idx on public.lancamentos (casa_id, recurring_id);
create index if not exists lancamentos_casa_atualizacao_idx on public.lancamentos (casa_id, updated_at desc);

-- ---------------------------------------------------------------------
-- 4) Metas
-- ---------------------------------------------------------------------
create table if not exists public.metas (
  id text primary key,
  casa_id uuid not null references public.casas(id) on delete cascade,
  title text not null,
  category text not null default 'other',
  deadline text,
  target numeric(14, 2) not null default 0,
  current numeric(14, 2) not null default 0,
  archived boolean not null default false,
  contributions jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists metas_casa_idx on public.metas (casa_id);

-- ---------------------------------------------------------------------
-- 5) Contas e carteiras
-- ---------------------------------------------------------------------
create table if not exists public.contas (
  id text primary key,
  casa_id uuid not null references public.casas(id) on delete cascade,
  name text not null,
  type text not null default 'Conta',
  color text not null default '#00b4a0',
  position integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contas_casa_idx on public.contas (casa_id, position);

-- Contas padrão da casa (as mesmas do aplicativo antigo).
insert into public.contas (id, casa_id, name, type, color, position)
values
  ('checking',    '00000000-0000-0000-0000-000000000001', 'Conta Principal', 'Conta corrente', '#00b4a0', 0),
  ('cash_wallet', '00000000-0000-0000-0000-000000000001', 'Carteira',        'Dinheiro',       '#ffb300', 1),
  ('reserve',     '00000000-0000-0000-0000-000000000001', 'Reserva',         'Investimentos',  '#9c7cfa', 2)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 6) Orçamento por categoria (limite mensal)
-- ---------------------------------------------------------------------
create table if not exists public.orcamentos (
  casa_id uuid not null references public.casas(id) on delete cascade,
  category text not null,
  amount numeric(14, 2) not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (casa_id, category)
);

-- ---------------------------------------------------------------------
-- 7) Carimbos automáticos: quem gravou e quando.
--    O aplicativo não envia esses campos; o banco preenche sozinho a
--    partir do usuário logado, então ninguém consegue "assinar" pelo outro.
-- ---------------------------------------------------------------------
create or replace function public.carimbar()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create or replace function public.marcar_atualizacao()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_carimbar_lancamentos on public.lancamentos;
create trigger trg_carimbar_lancamentos before insert or update on public.lancamentos
for each row execute function public.carimbar();

drop trigger if exists trg_carimbar_metas on public.metas;
create trigger trg_carimbar_metas before insert or update on public.metas
for each row execute function public.carimbar();

drop trigger if exists trg_carimbar_contas on public.contas;
create trigger trg_carimbar_contas before insert or update on public.contas
for each row execute function public.carimbar();

drop trigger if exists trg_carimbar_orcamentos on public.orcamentos;
create trigger trg_carimbar_orcamentos before insert or update on public.orcamentos
for each row execute function public.carimbar();

drop trigger if exists trg_atualizacao_membros on public.membros;
create trigger trg_atualizacao_membros before update on public.membros
for each row execute function public.marcar_atualizacao();

-- ---------------------------------------------------------------------
-- 8) Todo usuário novo vira membro da casa automaticamente
-- ---------------------------------------------------------------------
create or replace function public.novo_membro()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.membros (user_id, casa_id, nome)
  values (
    new.id,
    '00000000-0000-0000-0000-000000000001',
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(coalesce(new.email, 'usuario'), '@', 1)
    )
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_novo_membro on auth.users;
create trigger trg_novo_membro
after insert on auth.users
for each row execute function public.novo_membro();

-- Quem já existia antes de rodar este arquivo também entra na casa.
insert into public.membros (user_id, casa_id, nome)
select
  u.id,
  '00000000-0000-0000-0000-000000000001',
  coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'name'), ''),
    nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(u.email, 'usuario'), '@', 1)
  )
from auth.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- 9) Regras de acesso: cada pessoa só vê e mexe nos dados da própria casa
-- ---------------------------------------------------------------------
create or replace function public.minha_casa()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.casa_id from public.membros m where m.user_id = auth.uid() limit 1;
$$;

revoke all on function public.minha_casa() from public;
grant execute on function public.minha_casa() to authenticated;

alter table public.casas enable row level security;
alter table public.membros enable row level security;
alter table public.lancamentos enable row level security;
alter table public.metas enable row level security;
alter table public.contas enable row level security;
alter table public.orcamentos enable row level security;

revoke all on table public.casas, public.membros, public.lancamentos, public.metas, public.contas, public.orcamentos from anon;
grant select on table public.casas to authenticated;
grant select, update on table public.membros to authenticated;
grant select, insert, update, delete on table public.lancamentos to authenticated;
grant select, insert, update, delete on table public.metas to authenticated;
grant select, insert, update, delete on table public.contas to authenticated;
grant select, insert, update, delete on table public.orcamentos to authenticated;

drop policy if exists "casa: ver a minha" on public.casas;
create policy "casa: ver a minha" on public.casas
for select to authenticated using (id = public.minha_casa());

drop policy if exists "membros: ver os da casa" on public.membros;
create policy "membros: ver os da casa" on public.membros
for select to authenticated using (casa_id = public.minha_casa());

drop policy if exists "membros: editar o meu" on public.membros;
create policy "membros: editar o meu" on public.membros
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "lancamentos: casa" on public.lancamentos;
create policy "lancamentos: casa" on public.lancamentos
for all to authenticated using (casa_id = public.minha_casa()) with check (casa_id = public.minha_casa());

drop policy if exists "metas: casa" on public.metas;
create policy "metas: casa" on public.metas
for all to authenticated using (casa_id = public.minha_casa()) with check (casa_id = public.minha_casa());

drop policy if exists "contas: casa" on public.contas;
create policy "contas: casa" on public.contas
for all to authenticated using (casa_id = public.minha_casa()) with check (casa_id = public.minha_casa());

drop policy if exists "orcamentos: casa" on public.orcamentos;
create policy "orcamentos: casa" on public.orcamentos
for all to authenticated using (casa_id = public.minha_casa()) with check (casa_id = public.minha_casa());

-- ---------------------------------------------------------------------
-- 10) Tempo real: o que um celular grava aparece no outro em segundos.
--     "replica identity full" faz a exclusão chegar com a linha inteira.
-- ---------------------------------------------------------------------
alter table public.lancamentos replica identity full;
alter table public.metas replica identity full;
alter table public.contas replica identity full;
alter table public.orcamentos replica identity full;
alter table public.membros replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array['lancamentos', 'metas', 'contas', 'orcamentos', 'membros'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 11) Conferência final (só mostra, não altera)
-- ---------------------------------------------------------------------
select 'casa' as item, nome as valor from public.casas
union all
select 'membros', count(*)::text from public.membros
union all
select 'contas', count(*)::text from public.contas
union all
select 'lancamentos', count(*)::text from public.lancamentos
union all
select 'tempo real', coalesce(string_agg(tablename, ', ' order by tablename), 'nenhuma')
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public';
