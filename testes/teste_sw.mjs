// Testa o service worker (v2/sw.js) no Node com um "self" de mentira:
// aviso em segundo plano (push), clique no aviso e troca de versão.
//
// Uso: node testes/teste_sw.mjs
import { readFileSync } from 'node:fs';

const falhas = [];
const checar = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas.push(msg); };

const src = readFileSync(new URL('../v2/sw.js', import.meta.url), 'utf8');
let janelas = [];
const mostradas = [];
const mensagens = [];
let aberto = null;
const self = {
  listeners: {},
  addEventListener(tipo, fn) { this.listeners[tipo] = fn; },
  clients: { matchAll: async () => janelas, openWindow: async (u) => { aberto = u; return {}; }, claim: async () => {} },
  registration: { showNotification: async (t, o) => { mostradas.push({ t, o }); } },
  skipWaiting: async () => {},
  location: { origin: 'http://127.0.0.1:8765' }
};
new Function('self', 'caches', 'fetch', src)(self, {}, async () => new Response(''));
const esperar = async (ev) => { for (const p of ev._p) await p; };
const evento = (extra) => ({ _p: [], waitUntil(p) { this._p.push(p); }, ...extra });

console.log('== 1. Push com o app fechado mostra a notificação');
let ev = evento({ data: { json: () => ({ title: 'Thainá lançou uma despesa', body: 'Mercado · R$ 120,00 · 05/12', tag: 'lanc-1', url: './index.html?page=control' }) } });
self.listeners.push(ev);
await esperar(ev);
checar(mostradas.length === 1 && mostradas[0].t === 'Thainá lançou uma despesa', 'título do aviso');
checar(mostradas[0].o.body === 'Mercado · R$ 120,00 · 05/12' && mostradas[0].o.tag === 'lanc-1' && mostradas[0].o.data.url === './index.html?page=control', 'corpo, etiqueta e endereço');
checar(mostradas[0].o.icon && mostradas[0].o.badge, 'ícone e selo do aviso');

console.log('== 2. Push com o app na frente não duplica (a tela mostra)');
janelas = [{ visibilityState: 'visible', focused: true, postMessage: (m) => mensagens.push(m), focus: async () => {} }];
ev = evento({ data: { json: () => ({ title: 'T2', body: 'B2', tag: 'x' }) } });
self.listeners.push(ev);
await esperar(ev);
checar(mostradas.length === 1, 'nenhuma notificação nova');
checar(mensagens.length === 1 && mensagens[0].type === 'PUSH_VISTO' && mensagens[0].dados.title === 'T2', 'a página recebe o aviso por mensagem');

console.log('== 3. Push sem JSON não quebra');
janelas = [];
ev = evento({ data: { json: () => { throw new Error('não é JSON'); }, text: () => 'texto puro' } });
self.listeners.push(ev);
await esperar(ev);
checar(mostradas.length === 2 && mostradas[1].o.body === 'texto puro', 'mostra o texto puro com título padrão');

console.log('== 4. Clique no aviso abre o app no endereço certo');
let fechado = false;
ev = evento({ notification: { close: () => { fechado = true; }, data: { url: './index.html?page=control' } } });
self.listeners.notificationclick(ev);
await esperar(ev);
checar(fechado && aberto === './index.html?page=control', 'sem janela aberta: abre uma nova no endereço do aviso');
let focada = false;
janelas = [{ visibilityState: 'hidden', focus: async () => { focada = true; return {}; }, navigate: async () => {} }];
aberto = null;
ev = evento({ notification: { close: () => {}, data: { url: './index.html' } } });
self.listeners.notificationclick(ev);
await esperar(ev);
checar(focada && aberto === null, 'com janela aberta: só traz o app para a frente');

console.log('== 5. Mensagem SKIP_WAITING continua funcionando');
let pulou = false;
self.skipWaiting = async () => { pulou = true; };
self.listeners.message({ data: { type: 'SKIP_WAITING' } });
checar(pulou, 'skipWaiting chamado');

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK (service worker)');
process.exit(falhas.length ? 1 : 0);
