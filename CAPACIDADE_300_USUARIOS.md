# Plano para suportar 300 usuários

Este documento define o mínimo necessário para o Controle Financeiro suportar pelo menos 300 usuários sem problemas operacionais.

## Diagnóstico da estrutura atual

O app consegue iniciar vendas porque o frontend é leve e estático. O ponto de atenção está no Supabase:

- Cada usuário salva o estado financeiro em um JSON único na tabela `user_states`.
- Cada alteração salva o estado completo, não apenas o item alterado.
- O painel administrativo carregava todas as colunas de todos os usuários.
- Ainda faltava estrutura própria para plano mensal, semestral e anual.

Para 300 usuários, isso ainda é aceitável se fizermos contenção de escrita, índices e organização do acesso.

## Meta inicial

Suportar:

- 300 usuários cadastrados.
- 50 a 100 usuários ativos no mesmo dia.
- Uso pessoal normal, com lançamentos financeiros e consulta de relatórios.
- Painel admin funcionando sem travar.

## Melhorias já preparadas

### 1. Redução de escritas na nuvem

O tempo de espera antes de sincronizar foi aumentado de `900ms` para `2500ms`.

Resultado esperado:

- Menos gravações enquanto o usuário edita várias coisas em sequência.
- Menos carga no Supabase.
- Menor chance de conflito ou lentidão.

### 2. Painel admin com consulta mais leve

O painel admin agora busca apenas as colunas necessárias e limita a listagem em `500` registros.

Resultado esperado:

- Suporta os primeiros 300 usuários com folga.
- Reduz tráfego e processamento.
- Evita carregar dados grandes sem necessidade.

### 3. SQL de capacidade

Foi criado o arquivo:

`supabase_melhoria_capacidade_300.sql`

Ele adiciona:

- Campo `plan_type`.
- Campos de origem de compra.
- Campos de início/atualização de assinatura.
- Índices para status, validade, plano e datas.
- Função `admin_apply_access_plan` para aplicar plano mensal, semestral ou anual.

## Estrutura recomendada dos planos

Use estes identificadores internos:

- `monthly`: mensal.
- `semiannual`: semestral.
- `annual`: anual.
- `trial`: teste.
- `manual`: acesso manual/admin.

## Como operar para 300 usuários

### Venda manual inicial

1. Cliente compra na Hotmart ou Kiwify.
2. Você recebe a confirmação.
3. Você cria o acesso no painel admin.
4. Você escolhe o plano.
5. O sistema calcula a validade.
6. Cliente recebe login e senha temporária.

### Rotina semanal

- Verificar usuários expirando nos próximos 7 dias.
- Verificar usuários bloqueados.
- Conferir pagamentos pendentes na plataforma de venda.
- Exportar backup do Supabase.

## Limites aceitáveis nessa fase

Com a estrutura atual melhorada:

- Até 300 usuários: objetivo seguro.
- Até 500 usuários: possível, com monitoramento.
- Acima de 500 usuários: começar migração para tabelas separadas.

## Quando migrar para estrutura maior

Migrar quando ocorrer qualquer um destes sinais:

- JSON do usuário ficando grande demais.
- Sincronização demorando mais de 3 segundos com frequência.
- Usuários reclamando de dados sobrescritos.
- Painel admin demorando para carregar.
- Mais de 500 clientes ativos.

## Próxima arquitetura depois de validar vendas

Separar dados em tabelas:

- `transactions`
- `goals`
- `accounts`
- `budgets`
- `subscriptions`
- `payments`

Essa mudança melhora relatórios, auditoria, sincronização e escala, mas não é obrigatória antes das primeiras vendas.

## Checklist antes de anunciar

- Rodar `supabase_melhoria_senha_temporaria_hash.sql`.
- Rodar `supabase_melhoria_capacidade_300.sql`.
- Testar criação de acesso mensal.
- Testar criação de acesso semestral.
- Testar criação de acesso anual.
- Testar usuário expirado.
- Testar usuário bloqueado.
- Testar 20 lançamentos rápidos para validar sincronização.
- Testar painel admin com pelo menos 20 usuários fake ou teste.
