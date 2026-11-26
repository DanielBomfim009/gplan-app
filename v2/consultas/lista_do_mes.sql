-- =====================================================================
--  Lista do mês (só leitura): tudo que VENCE ou é PAGO/RECEBIDO no mês,
--  com o status de cada item. Troque a data na primeira linha para
--  outro mês (sempre dia 01). Rode no SQL Editor do Supabase e use o
--  botão de copiar/baixar CSV do resultado.
-- =====================================================================
with mes as (select date '2026-12-01' as ini)
select
  to_char(l.date, 'DD/MM') as vencimento,
  to_char(l.data_pagamento, 'DD/MM') as pagamento,
  case when l.type = 'income' then 'Receita' else 'Despesa' end as tipo,
  l.description as descricao,
  l.amount as valor,
  case when l.status = 'paid'
       then (case when l.type = 'income' then 'Recebido' else 'Pago' end)
       else (case when l.type = 'income' then 'A receber' else 'A pagar' end) end as status,
  l.category as categoria,
  coalesce(c.name, l.account_id) as conta,
  coalesce(m.nome, '') as quem_lancou,
  case when l.recurring then 'sim' else '' end as recorrente
from public.lancamentos l
left join public.contas c on c.id = l.account_id and c.casa_id = l.casa_id
left join public.membros m on m.user_id = l.created_by
cross join mes
where (l.date >= mes.ini and l.date < mes.ini + interval '1 month')
   or (l.data_pagamento >= mes.ini and l.data_pagamento < mes.ini + interval '1 month')
order by coalesce(l.data_pagamento, l.date), l.date, l.description;
