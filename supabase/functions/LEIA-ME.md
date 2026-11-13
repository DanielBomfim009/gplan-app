# Avisos com o app fechado (passo a passo no Supabase)

Tudo isto é feito uma vez só, pelo painel do Supabase (não precisa instalar nada no computador).
Os segredos ficam no arquivo `segredos_push.local.txt`, na pasta `GplanControleFinanceiro`
(fora do GitHub). Nunca cole a chave privada no código nem no GitHub.

## 1. Criar a função `enviar-push`

1. Supabase, projeto `controle-casa`, menu **Edge Functions**.
2. **Deploy a new function** e escolha **Via Editor** (escrever no navegador).
3. Nome da função: `enviar-push` (exatamente assim).
4. Apague o exemplo que aparece no editor, abra o arquivo
   `gplan-app\supabase\functions\enviar-push\index.ts`, copie tudo e cole no editor.
5. Clique em **Deploy function**.

## 2. Desligar a verificação de JWT nessa função

O banco chama a função com um segredo próprio, não com login de usuário.

1. Ainda em **Edge Functions**, clique em `enviar-push`.
2. Aba **Details** (ou o botão de configurações da função).
3. Desligue **Verify JWT with legacy secret** (pode aparecer como "Enforce JWT verification") e salve.

## 3. Colar os segredos

1. Em **Edge Functions**, aba **Secrets** (ou Settings, Edge Functions, Secrets).
2. Abra `segredos_push.local.txt` e crie um secret para cada linha:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (troque pelo seu e-mail, no formato `mailto:seu@email.com`)
   - `GPLAN_PUSH_SEGREDO`
3. Salve.

## 4. Rodar o SQL 2.3

1. Abra `gplan-app\v2\supabase_v2_3_avisos.sql`, copie tudo.
2. No Supabase, **SQL Editor**, New query, cole.
3. Procure `COLE_AQUI_O_SEGREDO` (aparece uma vez, na parte 2) e troque pelo
   `GPLAN_PUSH_SEGREDO` do arquivo de segredos. Deixe entre as aspas simples.
4. **Run**. A conferência no fim deve mostrar `segredo preenchido: ok` e `pg_net: ok`.
   Se `lembrete diário` vier "não agendado": menu **Database**, **Extensions**,
   procure `pg_cron`, ative e rode o SQL de novo.

## 5. Testar no celular

1. Feche e abra o app. Em **Configurações, Avisos**, toque em **Ligar avisos neste aparelho**.
2. Deve aparecer "Com o app fechado: ligado neste aparelho".
3. Toque em **Testar aviso agora**. Um aviso vem do próprio aparelho na hora e outro vem
   pela nuvem em alguns segundos. Feche o app e peça para a outra pessoa lançar algo.

## Se não chegar nada

- **Edge Functions, enviar-push, Logs**: mostra cada chamada do banco e o resultado
  (`enviados`, `removidas`, `falhas`).
- `falhas: ["HTTP 401"]` ou `403`: chave VAPID diferente entre o `config.js` e os Secrets.
- Resposta `não autorizado`: o segredo do SQL é diferente do secret `GPLAN_PUSH_SEGREDO`.
- Nada nos logs: o SQL 2.3 não rodou ou o segredo ficou como `COLE_AQUI_O_SEGREDO`.
- iPhone: só recebe com o app instalado na tela inicial (Compartilhar, Adicionar à Tela de Início)
  e iOS 16.4 ou mais novo.
