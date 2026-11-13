-- =====================================================================
--  Controle Financeiro v2.3b  -  só grava o segredo dos avisos
--  Use quando o SQL 2.3 já rodou mas a conferência disse
--  "segredo preenchido: NÃO".
--
--  ANTES DE RODAR: troque COLE_AQUI_O_SEGREDO (uma vez, logo abaixo)
--  pelo GPLAN_PUSH_SEGREDO do arquivo segredos_push.local.txt, o mesmo
--  que você colou nos "Secrets" da função enviar-push. Deixe as aspas.
-- =====================================================================

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

-- Arrumação: estas funções só fazem sentido para quem está logado.
revoke all on function public.testar_push() from anon;
revoke all on function public.apagar_tudo_da_casa() from anon;
revoke all on function public.sou_admin() from anon;

-- Conferência (só mostra, não altera)
select * from public.avisos_status();
