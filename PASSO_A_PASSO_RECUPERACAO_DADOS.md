# Passo a passo de recuperação de dados

Use este roteiro para tentar recuperar as transações do perfil administrador sem sobrescrever dados por engano.

## 1. Atualizar o app

Suba os arquivos atualizados:

- `index.html`
- `sw.js`

Depois, abra o app e force atualização:

- no navegador: `Ctrl + F5`;
- no celular: fechar o app, abrir novamente e, se necessário, limpar cache do site.

## 2. Tentar recuperação local

1. Entre na conta administradora.
2. Abra `Configurações`.
3. Vá até a seção `Dados`.
4. Toque em `Buscar recuperação local`.
5. Se o app encontrar uma cópia com transações, confirme a restauração.

O app cria um ponto de recuperação antes de restaurar, então o estado atual fica guardado no navegador.

## 3. Tentar importar o backup exportado

1. Entre na conta administradora.
2. Abra `Configurações`.
3. Vá até `Dados`.
4. Toque em `Importar cópia de segurança`.
5. Selecione o arquivo `.json` exportado.

A importação agora aceita estes formatos:

- backup antigo direto do estado do app;
- backup novo com `app_state`;
- exportação contendo `state`.

## 4. Verificar se ainda existe cópia na nuvem

No Supabase, rode:

```text
supabase_diagnostico_recuperacao_dados.sql
```

Esse SQL não altera dados. Ele mostra quantas transações existem em cada `user_state`, incluindo o perfil admin.

## 5. Proteção adicionada

O app agora bloqueia uma sincronização vazia quando a nuvem ainda tem transações. Isso evita que uma tela vazia sobrescreva dados existentes por acidente.

## 6. Se ainda não recuperar

Envie para análise o arquivo `.json` que foi exportado anteriormente. Com o arquivo em mãos, dá para verificar se as transações estão dentro dele e ajustar o formato manualmente se necessário.

