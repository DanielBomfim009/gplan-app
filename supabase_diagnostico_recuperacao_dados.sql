-- Diagnostico seguro de recuperacao de dados
-- Objetivo: descobrir se as transacoes ainda existem na tabela public.user_states.
-- Este arquivo NAO altera dados. Ele apenas consulta.

-- 1) Liste todos os estados salvos na nuvem, com quantidade de transacoes.
select
  coalesce(p.email, u.email) as email,
  p.full_name,
  p.role,
  s.user_id,
  jsonb_array_length(coalesce(s.app_state->'transactions', '[]'::jsonb)) as total_transacoes,
  jsonb_array_length(coalesce(s.app_state->'goals', '[]'::jsonb)) as total_metas,
  s.updated_at
from public.user_states s
left join public.app_profiles p on p.user_id = s.user_id
left join auth.users u on u.id = s.user_id
order by s.updated_at desc;

-- 2) Resumo somente de perfis admin.
select
  coalesce(p.email, u.email) as email,
  p.full_name,
  p.role,
  jsonb_array_length(coalesce(s.app_state->'transactions', '[]'::jsonb)) as total_transacoes,
  s.updated_at
from public.user_states s
left join public.app_profiles p on p.user_id = s.user_id
left join auth.users u on u.id = s.user_id
where p.role = 'admin'
order by s.updated_at desc;

-- 3) Amostra das ultimas transacoes do admin.
-- Se retornar linhas, os dados ainda existem na nuvem.
select
  coalesce(p.email, u.email) as email,
  tx.value->>'id' as transacao_id,
  tx.value->>'title' as titulo,
  tx.value->>'type' as tipo,
  tx.value->>'status' as status,
  tx.value->>'date' as data,
  tx.value->>'amount' as valor,
  s.updated_at as estado_atualizado_em
from public.user_states s
left join public.app_profiles p on p.user_id = s.user_id
left join auth.users u on u.id = s.user_id
cross join lateral jsonb_array_elements(coalesce(s.app_state->'transactions', '[]'::jsonb)) tx(value)
where p.role = 'admin'
order by coalesce(tx.value->>'date', '') desc
limit 50;

-- 4) Se voce souber o e-mail exato do admin, substitua abaixo e rode separado.
-- Isso ajuda a confirmar se a conta correta esta sendo carregada.
/*
select
  coalesce(p.email, u.email) as email,
  p.full_name,
  p.role,
  jsonb_pretty(s.app_state) as estado_completo,
  s.updated_at
from public.user_states s
left join public.app_profiles p on p.user_id = s.user_id
left join auth.users u on u.id = s.user_id
where lower(coalesce(p.email, u.email)) = lower('SEU_EMAIL_ADMIN_AQUI')
limit 1;
*/

