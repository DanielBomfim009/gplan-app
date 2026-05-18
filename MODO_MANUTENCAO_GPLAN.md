# Modo manutenção - GPlan

## Onde controlar

Arquivo:

`maintenance.json`

## Como ativar

Troque:

```json
"enabled": false
```

para:

```json
"enabled": true
```

Você também pode ajustar:

- `title`
- `message`
- `detail`
- `window_label`

## Como desativar

Volte `enabled` para `false` e publique o app novamente.

## O que acontece quando está ativo

- bloqueia login
- bloqueia sincronização
- esconde a interface normal
- mostra tela oficial de manutenção com suporte

## Quando usar

Use para mudanças críticas, como:

- autenticação
- regras de acesso
- sincronização
- SQL / banco
- segurança
- alterações estruturais do admin

## Fluxo recomendado

1. Fazer backup
2. Ativar manutenção
3. Publicar
4. Validar que a tela de manutenção apareceu
5. Aplicar mudanças críticas
6. Testar localmente / em ambiente controlado
7. Desativar manutenção
8. Publicar novamente
