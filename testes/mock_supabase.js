/* Supabase FALSO para testes no navegador.
   - Banco em localStorage (compartilhado entre abas da mesma origem).
   - Sessão em sessionStorage (cada aba pode ser uma pessoa diferente).
   - Tempo real por BroadcastChannel (uma aba avisa as outras).
   - Imita só o que o app.js usa: auth, from().select/upsert/update/delete, channel.
   Nunca fala com a internet. */
(function () {
  const CASA = '00000000-0000-0000-0000-000000000001';
  const USERS = [
    { id: 'u1', email: 'daniel@teste.com', password: '123456', nome: 'Daniel', cor: '#00b4a0' },
    { id: 'u2', email: 'maria@teste.com', password: '123456', nome: 'Maria', cor: '#ffb300' }
  ];
  const DB_KEY = 'mock-db';
  const SESSION_KEY = 'mock-session';
  const LATENCY_MS = 15;
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => new Date().toISOString();
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('mock-realtime') : null;
  const channels = new Set();
  const authListeners = new Set();
  window.__mockStats = { writes: 0, reads: 0, realtimeEmitted: 0 };

  function seed() {
    return {
      casas: [{ id: CASA, nome: 'Casa Teste', created_at: now() }],
      membros: USERS.map(u => ({ user_id: u.id, casa_id: CASA, nome: u.nome, cor: u.cor, foto: null, created_at: now(), updated_at: now() })),
      contas: [
        { id: 'checking', casa_id: CASA, name: 'Conta Principal', type: 'Conta corrente', color: '#00b4a0', position: 0 },
        { id: 'cash_wallet', casa_id: CASA, name: 'Carteira', type: 'Dinheiro', color: '#ffb300', position: 1 },
        { id: 'reserve', casa_id: CASA, name: 'Reserva', type: 'Investimentos', color: '#9c7cfa', position: 2 }
      ],
      lancamentos: [],
      metas: [],
      orcamentos: []
    };
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* recria */ }
    const db = seed();
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
  }

  function saveDb(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }

  function setSession(session) {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  }

  function fireAuth(event, session) {
    authListeners.forEach(cb => { try { cb(event, session); } catch (e) { console.error('mock auth listener', e); } });
  }

  function pk(table) { return table === 'orcamentos' ? ['casa_id', 'category'] : table === 'membros' ? ['user_id'] : ['id']; }

  function rowKey(table, row, cols) { return (cols || pk(table)).map(c => String(row[c])).join('|'); }

  function emit(table, eventType, newRow, oldRow) {
    const payload = { table, eventType, new: newRow || {}, old: oldRow || {}, schema: 'public', commit_timestamp: now() };
    window.__mockStats.realtimeEmitted += 1;
    deliver(payload);
    if (bc) bc.postMessage(payload);
  }

  function deliver(payload) {
    channels.forEach(ch => {
      if (!ch.subscribed) return;
      ch.handlers.forEach(h => {
        if (h.filter.table !== payload.table) return;
        if (h.filter.event && h.filter.event !== '*' && h.filter.event !== payload.eventType) return;
        if (h.filter.filter) {
          const m = String(h.filter.filter).match(/^(\w+)=eq\.(.+)$/);
          if (m) {
            const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
            if (String(row[m[1]]) !== m[2]) return;
          }
        }
        try { h.cb(payload); } catch (e) { console.error('mock realtime handler', e); }
      });
    });
  }

  if (bc) bc.onmessage = (ev) => deliver(ev.data);

  function currentUser() { return getSession()?.user || null; }

  function minhaCasa(db) {
    const u = currentUser();
    if (!u) return null;
    return db.membros.find(m => m.user_id === u.id)?.casa_id || null;
  }

  function visible(db, table, row) {
    const casa = minhaCasa(db);
    if (!casa) return false;
    if (table === 'casas') return row.id === casa;
    return row.casa_id === casa;
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = 'select';
      this._order = null;
      this._range = null;
      this._limit = null;
    }
    select() { if (this.op === 'select') return this; return this; }
    eq(k, v) { this.filters.push(r => String(r[k]) === String(v)); return this; }
    in(k, arr) { const s = new Set((arr || []).map(String)); this.filters.push(r => s.has(String(r[k]))); return this; }
    match(obj) { Object.entries(obj || {}).forEach(([k, v]) => this.eq(k, v)); return this; }
    order(k, opts = {}) { this._order = { k, ascending: opts.ascending !== false }; return this; }
    range(a, b) { this._range = [a, b]; return this; }
    limit(n) { this._limit = n; return this; }
    upsert(rows, opts = {}) { this.op = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; this.onConflict = String(opts.onConflict || pk(this.table).join(',')).split(','); return this; }
    insert(rows) { return this.upsert(rows); }
    update(patch) { this.op = 'update'; this.patch = patch || {}; return this; }
    delete() { this.op = 'delete'; return this; }
    then(resolve, reject) { return this.exec().then(resolve, reject); }
    async exec() {
      await delay(LATENCY_MS);
      if (!navigator.onLine || window.__mockOffline) return { data: null, error: { message: 'TypeError: Failed to fetch' } };
      if (window.__mockFailNext) { window.__mockFailNext = false; return { data: null, error: { message: 'erro simulado', code: '23514', status: 400 } }; }
      const db = loadDb();
      const user = currentUser();
      if (!user) return { data: null, error: { message: 'JWT expired', status: 401 } };
      if (!db[this.table]) return { data: null, error: { message: `relation "${this.table}" does not exist`, status: 404 } };
      const casa = minhaCasa(db);
      const matches = (r) => visible(db, this.table, r) && this.filters.every(f => f(r));

      if (this.op === 'select') {
        window.__mockStats.reads += 1;
        let rows = db[this.table].filter(matches).map(r => ({ ...r }));
        if (this._order) {
          const { k, ascending } = this._order;
          rows.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
        if (this._limit != null) rows = rows.slice(0, this._limit);
        return { data: rows, error: null };
      }

      if (this.op === 'upsert') {
        window.__mockStats.writes += 1;
        const results = [];
        for (const incoming of this.rows) {
          if (this.table !== 'membros' && this.table !== 'casas' && incoming.casa_id !== casa) {
            return { data: null, error: { message: 'new row violates row-level security policy', code: '42501', status: 403 } };
          }
          const key = rowKey(this.table, incoming, this.onConflict);
          const idx = db[this.table].findIndex(r => rowKey(this.table, r, this.onConflict) === key);
          if (idx > -1) {
            const old = db[this.table][idx];
            const updated = { ...old, ...incoming, created_at: old.created_at, created_by: old.created_by, updated_at: now(), updated_by: user.id };
            db[this.table][idx] = updated;
            results.push({ type: 'UPDATE', new: updated, old });
          } else {
            const created = { ...incoming, created_at: now(), created_by: user.id, updated_at: now(), updated_by: user.id };
            db[this.table].push(created);
            results.push({ type: 'INSERT', new: created, old: {} });
          }
        }
        saveDb(db);
        results.forEach(r => emit(this.table, r.type, r.new, r.old));
        return { data: null, error: null };
      }

      if (this.op === 'update') {
        window.__mockStats.writes += 1;
        const changed = [];
        db[this.table] = db[this.table].map(r => {
          if (!matches(r)) return r;
          const updated = { ...r, ...this.patch, updated_at: now() };
          if (this.table !== 'membros') updated.updated_by = user.id;
          changed.push({ new: updated, old: r });
          return updated;
        });
        saveDb(db);
        changed.forEach(c => emit(this.table, 'UPDATE', c.new, c.old));
        return { data: null, error: null };
      }

      if (this.op === 'delete') {
        window.__mockStats.writes += 1;
        const removed = db[this.table].filter(matches);
        db[this.table] = db[this.table].filter(r => !matches(r));
        saveDb(db);
        removed.forEach(r => emit(this.table, 'DELETE', {}, r));
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'operação desconhecida' } };
    }
  }

  function createClient() {
    const client = {
      from(table) { return new Query(table); },
      channel(name) {
        const ch = { name, handlers: [], subscribed: false,
          on(type, filter, cb) { this.handlers.push({ type, filter, cb }); return this; },
          subscribe(cb) { setTimeout(() => { this.subscribed = true; cb && cb('SUBSCRIBED'); }, 20); return this; },
          unsubscribe() { this.subscribed = false; return Promise.resolve('ok'); }
        };
        channels.add(ch);
        return ch;
      },
      removeChannel(ch) { if (ch) { ch.subscribed = false; channels.delete(ch); } return Promise.resolve('ok'); },
      auth: {
        onAuthStateChange(cb) {
          authListeners.add(cb);
          setTimeout(() => cb('INITIAL_SESSION', getSession()), 10);
          return { data: { subscription: { unsubscribe() { authListeners.delete(cb); } } } };
        },
        async getSession() { await delay(5); return { data: { session: getSession() }, error: null }; },
        async signInWithPassword({ email, password }) {
          await delay(LATENCY_MS);
          if (!navigator.onLine || window.__mockOffline) return { data: {}, error: { message: 'TypeError: Failed to fetch' } };
          const u = USERS.find(x => x.email === String(email).toLowerCase() && x.password === password);
          if (!u) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
          const session = { user: { id: u.id, email: u.email }, access_token: 'mock' };
          setSession(session);
          setTimeout(() => fireAuth('SIGNED_IN', session), 0);
          return { data: session, error: null };
        },
        async signOut() { await delay(5); setSession(null); setTimeout(() => fireAuth('SIGNED_OUT', null), 0); return { error: null }; },
        async updateUser({ password }) { await delay(5); window.__mockLastPassword = password; return { data: { user: currentUser() }, error: null }; },
        async resetPasswordForEmail(email, opts) { await delay(5); window.__mockResetFor = { email, opts }; return { data: {}, error: null }; }
      }
    };
    return client;
  }

  window.supabase = { createClient };
  window.__mockFireRecovery = () => fireAuth('PASSWORD_RECOVERY', getSession());
})();
