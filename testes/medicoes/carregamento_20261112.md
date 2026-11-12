# Carregamento da página v2 no ar - 12/11/2026

Medido com `medir_carga.py` (Chromium, 3 aberturas com contexto novo cada, mediana),
pela rede da empresa (proxy). Antes = commit 792bd53; depois = commit 72a43a4.

| Medida | Antes | Depois |
|---|---:|---:|
| Primeira pintura | 1.276 ms | 944 ms |
| DOM pronto | 1.252 ms | 925 ms |
| Tela de entrada visível | 1.365 ms | 1.239 ms |
| Tudo carregado | 1.744 ms | 1.456 ms |
| Bytes transferidos | 154 KB | 161 KB |
| Pedidos | 8 | 8 |

O que mudou entre as duas: biblioteca do Supabase com `defer`, fonte do Google sem
travar a primeira pintura, preconnect ao banco, e o CSS do Tailwind já era local.
Os bytes subiram um pouco porque o app.js ganhou a administração da casa.
