/* Supabase FALSO para testes no navegador.
   - Banco em localStorage (compartilhado entre abas da mesma origem).
   - Sessão em sessionStorage (cada aba pode ser uma pessoa diferente).
   - Tempo real por BroadcastChannel (uma aba avisa as outras).
   - Imita só o que o app.js usa: auth, from().select/upsert/update/delete, channel.
   Nunca fala com a internet. */
(function () {
  const CASA = '00000000-0000-0000-0000-000000000001';
  const USERS = [
    { id: 'u1', email: 'daniel@teste.com', password: '123456', nome: 'Daniel', cor: '#00b4a0', papel: 'admin' },
    { id: 'u2', email: 'maria@teste.com', password: '123456', nome: 'Maria', cor: '#ffb300', papel: 'membro' },
    { id: 'u3', email: 'ana@teste.com', password: '123456', nome: 'ana', cor: '#9c7cfa', papel: 'membro' }
  ];
  const USERS_KEY = 'mock-users';
  function loadUsers() {
    try { const extra = JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); return USERS.concat(extra); } catch (_) { return USERS.slice(); }
  }
  function addUser(u) {
    const extra = (() => { try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch (_) { return []; } })();
    extra.push(u);
    localStorage.setItem(USERS_KEY, JSON.stringify(extra));
  }
  // Colunas reais de cada tabela (iguais ao supabase_v2.sql). Coluna
  // desconhecida em filtro, ordenação ou gravação dá erro como no PostgREST.
  const SCHEMA = {
    casas: ['id', 'nome', 'created_at'],
    membros: ['user_id', 'casa_id', 'nome', 'cor', 'foto', 'papel', 'created_at', 'updated_at'],
    convites: ['email', 'casa_id', 'criado_por', 'criado_em', 'usado_por', 'usado_em'],
    historico: ['id', 'casa_id', 'user_id', 'acao', 'tabela', 'item_id', 'descricao', 'valor', 'criado_em'],
    lancamentos: ['id', 'casa_id', 'type', 'amount', 'description', 'date', 'category', 'account_id', 'payment_method', 'status', 'recurring', 'recurring_id', 'created_by', 'updated_by', 'created_at', 'updated_at'],
    metas: ['id', 'casa_id', 'title', 'category', 'deadline', 'target', 'current', 'archived', 'contributions', 'created_by', 'updated_by', 'created_at', 'updated_at'],
    contas: ['id', 'casa_id', 'name', 'type', 'color', 'position', 'created_by', 'updated_by', 'created_at', 'updated_at'],
    orcamentos: ['casa_id', 'category', 'amount', 'created_by', 'updated_by', 'created_at', 'updated_at'],
    user_states: ['user_id', 'app_state', 'updated_at']
  };
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
      membros: USERS.map(u => ({ user_id: u.id, casa_id: CASA, nome: u.nome, cor: u.cor, foto: null, papel: u.papel, created_at: now(), updated_at: now() })),
      convites: [],
      historico: [],
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

  let historicoSeq = Date.now();
  function registrarHistorico(db, table, tipo, novo, antigo) {
    if (table !== 'lancamentos' && table !== 'metas') return;
    if (window.__mockSilencio) return;
    const r = tipo === 'DELETE' ? antigo : novo;
    let acao;
    if (table === 'lancamentos') {
      if (tipo === 'INSERT') acao = 'criou';
      else if (tipo === 'DELETE') acao = 'excluiu';
      else if (novo.status !== antigo.status) acao = novo.status === 'paid' ? 'pagou' : 'reabriu';
      else acao = 'alterou';
    } else {
      acao = tipo === 'INSERT' ? 'criou meta' : tipo === 'DELETE' ? 'excluiu meta' : 'alterou meta';
    }
    db.historico = db.historico || [];
    const linha = { id: ++historicoSeq, casa_id: r.casa_id, user_id: currentUser()?.id || null, acao, tabela: table, item_id: String(r.id), descricao: table === 'lancamentos' ? r.description : r.title, valor: table === 'lancamentos' ? r.amount : r.current, criado_em: now() };
    db.historico.push(linha);
    setTimeout(() => emit('historico', 'INSERT', linha, {}), 0);
  }

  function minhaCasa(db) {
    const u = currentUser();
    if (!u) return null;
    return db.membros.find(m => m.user_id === u.id)?.casa_id || null;
  }

  function visible(db, table, row) {
    const casa = minhaCasa(db);
    if (!casa) return false;
    if (table === 'casas') return row.id === casa;
    if (table === 'user_states') return row.user_id === currentUser()?.id; // tabela da versão antiga
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
    _col(k) { const cols = SCHEMA[this.table]; if (cols && !cols.includes(k)) this._colError = this._colError || { message: `column ${this.table}.${k} does not exist`, code: '42703', status: 400 }; return k; }
    eq(k, v) { this._col(k); this.filters.push(r => String(r[k]) === String(v)); return this; }
    in(k, arr) { this._col(k); const s = new Set((arr || []).map(String)); this.filters.push(r => s.has(String(r[k]))); return this; }
    match(obj) { Object.entries(obj || {}).forEach(([k, v]) => this.eq(k, v)); return this; }
    order(k, opts = {}) { this._col(k); this._order = { k, ascending: opts.ascending !== false }; return this; }
    range(a, b) { this._range = [a, b]; return this; }
    limit(n) { this._limit = n; return this; }
    maybeSingle() { this._single = true; return this; }
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
      if (this._colError) return { data: null, error: this._colError };
      const cols = SCHEMA[this.table];
      if (cols && (this.op === 'upsert' || this.op === 'update')) {
        const enviados = this.op === 'upsert' ? this.rows.flatMap(r => Object.keys(r)) : Object.keys(this.patch);
        const estranha = enviados.find(k => !cols.includes(k));
        if (estranha) return { data: null, error: { message: `Could not find the '${estranha}' column of '${this.table}' in the schema cache`, code: 'PGRST204', status: 400 } };
      }
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
        if (this._single) return { data: rows[0] || null, error: null };
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
        results.forEach(r => registrarHistorico(db, this.table, r.type, r.new, r.old));
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
        changed.forEach(c => registrarHistorico(db, this.table, 'UPDATE', c.new, c.old));
        saveDb(db);
        changed.forEach(c => emit(this.table, 'UPDATE', c.new, c.old));
        return { data: null, error: null };
      }

      if (this.op === 'delete') {
        window.__mockStats.writes += 1;
        const removed = db[this.table].filter(matches);
        db[this.table] = db[this.table].filter(r => !matches(r));
        removed.forEach(r => registrarHistorico(db, this.table, 'DELETE', {}, r));
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
      async rpc(name, params) {
        await delay(LATENCY_MS);
        if (!navigator.onLine || window.__mockOffline) return { data: null, error: { message: 'TypeError: Failed to fetch' } };
        const db = loadDb();
        const user = currentUser();
        if (!user) return { data: null, error: { message: 'JWT expired', status: 401 } };
        if (name === 'apagar_tudo_da_casa') {
          const eu = db.membros.find(m => m.user_id === user.id);
          if (!eu || eu.papel !== 'admin') return { data: null, error: { message: 'Só o administrador da casa pode apagar tudo.', code: 'P0001' } };
          const casa = eu.casa_id;
          const conta = (t) => db[t].filter(r => r.casa_id === casa).length;
          const resultado = { lancamentos: conta('lancamentos'), metas: conta('metas'), orcamentos: conta('orcamentos') };
          ['lancamentos', 'metas', 'orcamentos', 'historico'].forEach(t => { db[t] = (db[t] || []).filter(r => r.casa_id !== casa); });
          db.historico.push({ id: ++historicoSeq, casa_id: casa, user_id: user.id, acao: 'apagou tudo', tabela: 'casa', item_id: null, descricao: `${resultado.lancamentos} lançamentos, ${resultado.metas} metas`, valor: null, criado_em: now() });
          saveDb(db);
          return { data: resultado, error: null };
        }
        return { data: null, error: { message: `Could not find the function public.${name}`, code: 'PGRST202', status: 404 } };
      },
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
          const u = loadUsers().find(x => x.email === String(email).toLowerCase() && x.password === password);
          if (!u) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
          const session = { user: { id: u.id, email: u.email }, access_token: 'mock' };
          setSession(session);
          setTimeout(() => fireAuth('SIGNED_IN', session), 0);
          return { data: session, error: null };
        },
        async signUp({ email, password, options }) {
          await delay(LATENCY_MS);
          if (!navigator.onLine || window.__mockOffline) return { data: {}, error: { message: 'TypeError: Failed to fetch' } };
          const mail = String(email || '').toLowerCase();
          if (loadUsers().some(x => x.email === mail)) return { data: { user: null, session: null }, error: { message: 'User already registered', status: 422 } };
          if (String(password || '').length < 6) return { data: {}, error: { message: 'Password should be at least 6 characters', status: 422 } };
          const db = loadDb();
          const conv = (db.convites || []).find(c => c.email === mail && !c.usado_em);
          if (!conv && db.membros.length) return { data: { user: null, session: null }, error: { message: 'Database error saving new user', status: 500 } };
          const id = `u${Date.now().toString(36)}`;
          const nome = (options && options.data && options.data.name) || mail.split('@')[0];
          addUser({ id, email: mail, password, nome, cor: '#00bcd4', papel: conv ? 'membro' : 'admin' });
          const membro = { user_id: id, casa_id: conv ? conv.casa_id : CASA, nome, cor: '#00bcd4', foto: null, papel: conv ? 'membro' : 'admin', created_at: now(), updated_at: now() };
          db.membros.push(membro);
          if (conv) { conv.usado_por = id; conv.usado_em = now(); }
          saveDb(db);
          emit('membros', 'INSERT', membro, {});
          const session = { user: { id, email: mail }, access_token: 'mock' };
          setSession(session);
          setTimeout(() => fireAuth('SIGNED_IN', session), 0);
          return { data: { user: session.user, session }, error: null };
        },
        async signOut() { await delay(5); setSession(null); setTimeout(() => fireAuth('SIGNED_OUT', null), 0); return { error: null }; },
        async updateUser({ password }) { await delay(5); window.__mockLastPassword = password; return { data: { user: currentUser() }, error: null }; },
        async resetPasswordForEmail(email, opts) { await delay(5); window.__mockResetFor = { email, opts }; return { data: {}, error: null }; }
      }
    };
    return client;
  }

  window.supabase = { createClient };
  window.__mockSeed = seed;
  window.__mockFireRecovery = () => fireAuth('PASSWORD_RECOVERY', getSession());
})();
