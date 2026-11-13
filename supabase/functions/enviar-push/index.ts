// @ts-nocheck
// =====================================================================
//  Controle Financeiro - função "enviar-push" (Supabase Edge Function)
//
//  O banco chama esta função (SQL 2.3) com
//    { casa_id, autor, destino, title, body, tag, url }
//  e ela manda o aviso aos aparelhos guardados em push_assinaturas:
//    - para todos os membros da casa, menos o autor (avisos normais);
//    - só para "destino", quando informado (aviso de teste).
//
//  Não usa nenhuma biblioteca: Web Push (RFC 8291/8188 + VAPID) feito
//  só com WebCrypto e fetch, que existem no Deno e no Node.
//
//  Segredos (Edge Functions > Secrets):
//    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:seu-email),
//    GPLAN_PUSH_SEGREDO (o mesmo colado no SQL 2.3).
//  SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o Supabase já fornece.
// =====================================================================

// >>> testavel (o teste em testes/teste_push_nuvem.mjs roda este trecho no Node)
const te = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => {
  const b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (b.length % 4)) % 4);
  const raw = atob(b + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const concat = (...arrs) => {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Chaves VAPID no formato padrão (base64url): pública = ponto de 65 bytes, privada = 32 bytes.
async function importVapidPrivateKey(publicKeyB64, privateKeyB64) {
  const pub = fromB64url(publicKeyB64);
  if (pub.length !== 65) throw new Error('VAPID_PUBLIC_KEY inválida (precisa ter 65 bytes).');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: privateKeyB64, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function vapidAuthorization(endpoint, subject, publicKeyB64, privateKey) {
  const aud = new URL(endpoint).origin;
  const header = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const data = te.encode(`${header}.${claims}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data); // já vem como r||s (64 bytes)
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${publicKeyB64}`;
}

// RFC 8291 / RFC 8188: cifra a mensagem para o aparelho (aes128gcm).
async function encryptPayload(p256dhB64, authB64, plaintext) {
  const uaPublic = fromB64url(p256dhB64);
  const authSecret = fromB64url(authB64);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const padded = concat(te.encode(plaintext), new Uint8Array([2])); // 0x02 = último registro
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));
  const rs = new Uint8Array([0, 0, 16, 0]); // tamanho do registro: 4096
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, cipher);
}

async function sendWebPush(sub, payload, vapid, fetchFn = fetch, ttl = 3600) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  const authorization = await vapidAuthorization(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(ttl),
      Urgency: 'high',
      Authorization: authorization
    },
    body
  });
  return res.status;
}

// Trata um pedido vindo do banco (ou de um teste).
async function tratar(req, env, fetchFn = fetch) {
  if (req.method !== 'POST') return new Response('método não permitido', { status: 405 });
  const segredo = env.GPLAN_PUSH_SEGREDO || '';
  if (!segredo || req.headers.get('x-gplan-segredo') !== segredo) return new Response('não autorizado', { status: 401 });
  let dados;
  try { dados = await req.json(); } catch (_) { return new Response('JSON inválido', { status: 400 }); }
  const { casa_id, autor, destino, title, body, tag, url } = dados || {};
  if (!casa_id || !title) return new Response('faltam campos (casa_id, title)', { status: 400 });
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return new Response('faltam os segredos VAPID', { status: 500 });

  const supaUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const service = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const rest = (path, init = {}) => fetchFn(`${supaUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });

  let filtro = `casa_id=eq.${encodeURIComponent(casa_id)}`;
  if (destino) filtro += `&user_id=eq.${encodeURIComponent(destino)}`;
  else if (autor) filtro += `&user_id=neq.${encodeURIComponent(autor)}`;
  const resp = await rest(`push_assinaturas?select=endpoint,p256dh,auth,user_id&${filtro}`);
  if (!resp.ok) return new Response(`erro ao ler assinaturas: ${resp.status}`, { status: 500 });
  const subs = await resp.json();

  const privateKey = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const vapid = { subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey: env.VAPID_PUBLIC_KEY, privateKey };
  const payload = { title, body: body || '', tag: tag || 'gplan', url: url || './index.html', ts: Date.now() };

  const mortas = [];
  const falhas = [];
  let enviados = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      const status = await sendWebPush(s, payload, vapid, fetchFn);
      if (status === 404 || status === 410) mortas.push(s.endpoint); // aparelho desinstalou ou revogou
      else if (status >= 200 && status < 300) enviados += 1;
      else falhas.push(`HTTP ${status}`);
    } catch (e) {
      falhas.push(String(e?.message || e));
    }
  }));
  for (const endpoint of mortas) {
    await rest(`push_assinaturas?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' }).catch(() => null);
  }
  return Response.json({ enviados, removidas: mortas.length, falhas });
}
// <<< testavel

Deno.serve((req) => tratar(req, Deno.env.toObject()));
