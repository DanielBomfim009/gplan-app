// Testa a função da nuvem (supabase/functions/enviar-push/index.ts) aqui no Node,
// sem Deno e sem internet: cifra uma mensagem e decifra do lado do "aparelho",
// confere a assinatura VAPID e simula o banco e o serviço de push.
//
// Uso: node testes/teste_push_nuvem.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const falhas = [];
const checar = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas.push(msg); };
const te = new TextEncoder();
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const hk = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));

// 1) Carrega só o trecho testável do index.ts como módulo
const src = readFileSync(new URL('../supabase/functions/enviar-push/index.ts', import.meta.url), 'utf8');
const ini = src.indexOf('// >>> testavel');
const fim = src.indexOf('// <<< testavel');
if (ini < 0 || fim < 0) { console.log('marcadores >>> testavel / <<< testavel não encontrados'); process.exit(1); }
const corpo = src.slice(ini, fim) + '\nexport { b64url, fromB64url, importVapidPrivateKey, vapidAuthorization, encryptPayload, sendWebPush, tratar };\n';
const pasta = mkdtempSync(join(tmpdir(), 'gplan-push-'));
const arq = join(pasta, 'nucleo_push.mjs');
writeFileSync(arq, corpo);
const m = await import(pathToFileURL(arq).href);

console.log('== 1. Cifra para o aparelho e o aparelho consegue decifrar (RFC 8291)');
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const auth = crypto.getRandomValues(new Uint8Array(16));
const sub = { endpoint: 'https://push.exemplo.com/envio/abc123', p256dh: m.b64url(uaPub), auth: m.b64url(auth) };
const texto = JSON.stringify({ title: 'Thainá lançou uma despesa', body: 'Mercado · R$ 120,00 · 05/12 (acentuação: ção)' });
const cifrado = await m.encryptPayload(sub.p256dh, sub.auth, texto);
const salt = cifrado.slice(0, 16);
const rs = new DataView(cifrado.buffer, cifrado.byteOffset + 16, 4).getUint32(0);
const idlen = cifrado[20];
const asPub = cifrado.slice(21, 21 + idlen);
const cipher = cifrado.slice(21 + idlen);
checar(rs === 4096 && idlen === 65, `cabeçalho aes128gcm (rs=${rs}, idlen=${idlen})`);
const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
const ikm = await hk(auth, ecdh, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
let end = plain.length - 1;
while (end >= 0 && plain[end] === 0) end -= 1;
checar(plain[end] === 2, 'delimitador de último registro (0x02) presente');
checar(new TextDecoder().decode(plain.slice(0, end)) === texto, 'texto decifrado é igual ao enviado (com acentos)');

console.log('== 2. Assinatura VAPID confere com a chave pública');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const VAPID_PUBLIC_KEY = m.b64url(pubRaw);
const VAPID_PRIVATE_KEY = jwk.d;
const priv = await m.importVapidPrivateKey(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const authz = await m.vapidAuthorization(sub.endpoint, 'mailto:teste@exemplo.com', VAPID_PUBLIC_KEY, priv);
const mt = authz.match(/^vapid t=([^,]+), k=(.+)$/);
checar(Boolean(mt) && mt[2] === VAPID_PUBLIC_KEY, 'cabeçalho Authorization no formato "vapid t=..., k=..."');
const [h, c, s] = mt[1].split('.');
const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, m.fromB64url(s), te.encode(`${h}.${c}`));
checar(ok, 'assinatura ES256 válida');
const claims = JSON.parse(new TextDecoder().decode(m.fromB64url(c)));
checar(claims.aud === 'https://push.exemplo.com' && claims.sub === 'mailto:teste@exemplo.com' && claims.exp > Date.now() / 1000 + 3600, 'aud, sub e validade do JWT');

console.log('== 3. Pedido do banco: envia aos outros membros, remove aparelho morto');
const env = { GPLAN_PUSH_SEGREDO: 's3gr3d0', SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: 'mailto:teste@exemplo.com' };
const chamadas = [];
const fetchFalso = async (url, init = {}) => {
  const u = String(url);
  chamadas.push({ url: u, init });
  if (u.includes('/rest/v1/push_assinaturas') && (!init.method || init.method === 'GET')) {
    return Response.json([{ ...sub, user_id: 'u2' }, { endpoint: 'https://push.exemplo.com/morta/x', p256dh: sub.p256dh, auth: sub.auth, user_id: 'u3' }]);
  }
  if (u.includes('/rest/v1/') && init.method === 'DELETE') return new Response('', { status: 204 });
  if (u.includes('/morta/')) return new Response('', { status: 410 });
  return new Response('', { status: 201 });
};
const pedido = (corpoJson, segredo = 's3gr3d0') => new Request('https://proj.supabase.co/functions/v1/enviar-push', { method: 'POST', headers: { 'x-gplan-segredo': segredo, 'content-type': 'application/json' }, body: JSON.stringify(corpoJson) });
const res = await m.tratar(pedido({ casa_id: 'c1', autor: 'u1', title: 'T', body: 'B', tag: 't1' }), env, fetchFalso);
const json = await res.json();
checar(res.status === 200 && json.enviados === 1 && json.removidas === 1 && json.falhas.length === 0, `resultado ${JSON.stringify(json)}`);
checar(chamadas[0].url.includes('casa_id=eq.c1') && chamadas[0].url.includes('user_id=neq.u1'), 'lê as assinaturas da casa sem o autor');
const envio = chamadas.find(x => x.url === sub.endpoint);
checar(Boolean(envio) && envio.init.headers['Content-Encoding'] === 'aes128gcm' && envio.init.headers.TTL === '3600' && String(envio.init.headers.Authorization).startsWith('vapid t='), 'envio ao serviço de push com os cabeçalhos certos');
checar(chamadas.some(x => x.init.method === 'DELETE' && x.url.includes('endpoint=eq.' + encodeURIComponent('https://push.exemplo.com/morta/x'))), 'assinatura morta (410) é apagada do banco');

console.log('== 4. Proteções');
checar((await m.tratar(pedido({ casa_id: 'c1', title: 'T' }, 'errado'), env, fetchFalso)).status === 401, 'segredo errado é recusado');
checar((await m.tratar(pedido({ title: 'T' }), env, fetchFalso)).status === 400, 'sem casa_id é recusado');
chamadas.length = 0;
await m.tratar(pedido({ casa_id: 'c1', autor: 'u1', destino: 'u1', title: 'Teste' }), env, fetchFalso);
checar(chamadas[0].url.includes('user_id=eq.u1') && !chamadas[0].url.includes('neq.'), 'com destino, manda só para aquele usuário (teste)');

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK (função da nuvem)');
process.exit(falhas.length ? 1 : 0);
