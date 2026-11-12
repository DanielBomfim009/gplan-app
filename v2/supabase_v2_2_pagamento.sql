-- =====================================================================
--  Controle Financeiro v2.2  -  data de pagamento
--  Rode este arquivo UMA vez, inteiro, no SQL Editor do Supabase.
--  Pode rodar de novo sem estragar nada.
--
--  Cada lançamento passa a ter duas datas:
--    date           = vencimento (a data que já existia)
--    data_pagamento = quando o dinheiro sai/entra de fato (opcional)
--  O app mostra e soma cada lançamento no mês da data de pagamento;
--  quando ela está vazia, vale o vencimento (como era antes).
-- =====================================================================

alter table public.lancamentos add column if not exists data_pagamento date;

comment on column public.lancamentos.data_pagamento is
  'Data em que o lançamento é pago/recebido. Vazia = no dia do vencimento (coluna date).';

-- Conferência (só mostra, não altera)
select 'coluna data_pagamento' as item,
       case when exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'lancamentos' and column_name = 'data_pagamento'
       ) then 'ok' else 'FALTA' end as valor
union all
select 'lançamentos com pagamento em outro dia', count(*)::text
  from public.lancamentos where data_pagamento is not null and data_pagamento <> date;
