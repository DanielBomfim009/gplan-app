/* =====================================================================
   Controle Financeiro v2 - aplicativo da casa (duas pessoas, tempo real)
   -----------------------------------------------------------------------
   Como funciona, em uma frase: cada lançamento é UMA linha no banco; o
   aplicativo guarda uma cópia no aparelho para abrir rápido e funcionar
   sem internet; toda alteração entra numa fila que é enviada à nuvem; e
   o que a outra pessoa gravar chega por tempo real e vira um aviso.
   ===================================================================== */

// ---------------------------------------------------------------------
// Configuração e constantes
// ---------------------------------------------------------------------
const CONFIG = window.GPLAN_CONFIG || {};
const SUPABASE_URL = String(CONFIG.supabaseUrl || '').trim();
const SUPABASE_KEY = String(CONFIG.supabaseKey || '').trim();
const APP_VERSION = '5.0.0';
const PAGE_SIZE = 1000;
const RECORRENCIA_MESES = 12;
const LS_NOTIF = 'gplan2:avisos';
const LS_LAST_USER = 'gplan2:ultimo_usuario';
const lsCacheKey = (uid) => `gplan2:cache:${uid}`;
const lsQueueKey = (uid) => `gplan2:fila:${uid}`;
const MEMBER_COLORS = ['#00b4a0', '#ffb300', '#9c7cfa', '#ff8a50', '#00c853', '#00bcd4', '#ff5252', '#4f7cff'];

const DEFAULT_CATEGORIES = {
  expense: [
    { id: 'credit_card', name: 'Cartão', color: '#ffb300' },
    { id: 'home', name: 'Moradia', color: '#00b4a0' },
    { id: 'food', name: 'Alimentação', color: '#00c853' },
    { id: 'transport', name: 'Transporte', color: '#9c7cfa' },
    { id: 'health', name: 'Saúde', color: '#ff5252' },
    { id: 'education', name: 'Educação', color: '#00bcd4' },
    { id: 'leisure', name: 'Lazer', color: '#ff8a50' },
    { id: 'other', name: 'Outros', color: '#6b8a99' }
  ],
  income: [
    { id: 'salary', name: 'Salário', color: '#00c853' },
    { id: 'freelance', name: 'Freelance', color: '#00b4a0' },
    { id: 'investment', name: 'Investimentos', color: '#ffb300' },
    { id: 'other', name: 'Outros', color: '#6b8a99' }
  ]
};

const DEFAULT_ACCOUNTS = [
  { id: 'checking', name: 'Conta Principal', type: 'Conta corrente', color: '#00b4a0', position: 0 },
  { id: 'cash_wallet', name: 'Carteira', type: 'Dinheiro', color: '#ffb300', position: 1 },
  { id: 'reserve', name: 'Reserva', type: 'Investimentos', color: '#9c7cfa', position: 2 }
];

const emptyBudgets = () => ({ credit_card: 0, home: 0, food: 0, transport: 0, health: 0, education: 0, leisure: 0, other: 0 });

// ---------------------------------------------------------------------
// Estado em memória (espelho do banco + preferências de tela)
// ---------------------------------------------------------------------
const State = {
  transactions: [],
  goals: [],
  accounts: DEFAULT_ACCOUNTS.map(a => ({ ...a })),
  budgets: emptyBudgets(),
  members: [],
  casa: { id: null, nome: CONFIG.nomeDaCasa || 'Nossa casa' },
  profile: { name: '', email: '', photo: null, color: '#00b4a0' },
  categories: DEFAULT_CATEGORIES,
  selectedPaymentMethod: 'credit',
  selectedAccountId: 'checking',
  isRecurring: false,
  controlFilter: 'all',
  controlPeriod: 'month',
  controlCustomDate: new Date(),
  dashboardPeriod: 'month',
  dashboardCustomDate: new Date(),
  txCustomDate: new Date(),
  reportCustomDate: new Date(),
  calendarSelectedDate: null
};

let client = null;            // cliente do Supabase
let me = null;                // usuário logado
let myMember = null;          // minha linha em "membros"
let casaId = null;
let channel = null;
let realtimeStatus = 'off';
let realtimeRetryTimer = null;
let queue = [];
let flushing = false;
let bootToken = 0;
let cloudLoaded = false;
let offlineMode = false;
let lastCloudReadAt = null;
let cacheSavedAt = null;
let renderTimer = null;
let noticeBuffer = [];
let noticeTimer = null;
let isChangingPassword = false;
let legacyCandidate = null;

let currentFilter = { type: 'all' };
let currentTxType = 'expense';
let currentTxStatus = 'pending';
let editingTxId = null;
let editingGoalId = null;
let editingAccountId = null;
let calDate = new Date();
let activeSettingsTab = 'profile';
let activeReportTab = 'summary';
let activeControlTab = 'income';
let activeDashboardTab = 'overview';
let activeGoalsTab = 'all';
let notifPrefs = loadNotifPrefs();

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
const formatMoney = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const parseMoney = (s) => { if (!s) return 0; return parseFloat(String(s).replace(/[^\d,]/g, '').replace(',', '.')) || 0; };
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const parseLocalDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const dateText = String(value).slice(0, 10);
  const match = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const toDateInputValue = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const todayInput = () => toDateInputValue(new Date());
const isDateInput = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const getMonthKeyFromDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const getMonthLabel = (date) => date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const formatDate = (d) => (parseLocalDate(d) || new Date()).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
const formatCurrency = (el) => { let v = el.value.replace(/\D/g, ''); v = (parseInt(v || 0, 10) / 100).toFixed(2).replace('.', ','); el.value = v; };
const getCategory = (id) => [...State.categories.expense, ...State.categories.income].find(c => c.id === id) || { name: 'Outros', color: '#6b8a99' };
const getAccount = (id) => State.accounts.find(a => a.id === id) || State.accounts[0] || { id: 'default', name: 'Conta', type: 'Conta', color: '#00b4a0' };
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const parseTimestamp = (value) => { const t = value ? new Date(value).getTime() : 0; return Number.isFinite(t) ? t : 0; };
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const GOAL_CATEGORIES = { reserve: 'Reserva', travel: 'Viagem', purchase: 'Compra', debt: 'Dívida', emergency: 'Emergência', other: 'Outro' };
const getGoalCategoryLabel = (category = 'other') => GOAL_CATEGORIES[category] || GOAL_CATEGORIES.other;
const sortTransactionsByDateDesc = (transactions) => [...transactions].sort((a, b) => {
  const dateDiff = (parseLocalDate(b.date)?.getTime() || 0) - (parseLocalDate(a.date)?.getTime() || 0);
  if (dateDiff !== 0) return dateDiff;
  return String(b.id).localeCompare(String(a.id), 'pt-BR', { numeric: true });
});
const sortTransactionsByDateAsc = (transactions) => [...transactions].sort((a, b) => {
  const dateDiff = (parseLocalDate(a.date)?.getTime() || 0) - (parseLocalDate(b.date)?.getTime() || 0);
  if (dateDiff !== 0) return dateDiff;
  return String(a.id).localeCompare(String(b.id), 'pt-BR', { numeric: true });
});
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeJsString = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
const initialsOf = (name = '') => String(name).trim().split(/\s+/).map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

function withTimeout(promise, ms, message) {
  let timerId;
  const timeout = new Promise((_, reject) => { timerId = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

function safeSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'error'
    ? '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>'
    : type === 'info'
      ? '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
      : '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
  toast.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, duration);
}

function askConfirm({ title = 'Confirmar', message = '', okLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    safeSetText('confirm-title', title);
    safeSetText('confirm-message', message);
    ok.textContent = okLabel;
    cancel.textContent = cancelLabel;
    ok.className = `delete-option-btn ${danger ? 'all' : 'single'}`;
    const finish = (value) => {
      modal.classList.remove('active');
      modal.onclick = null;
      ok.onclick = null;
      cancel.onclick = null;
      syncBodyLock();
      resolve(value);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    modal.classList.add('active');
    syncBodyLock();
  });
}

function syncBodyLock() {
  const hasActiveLayer = document.querySelector('.modal-overlay.active') || document.querySelector('.sidebar.active');
  document.body.style.overflow = hasActiveLayer ? 'hidden' : '';
}

// ---------------------------------------------------------------------
// Conversão entre as linhas do banco e os objetos da tela
// ---------------------------------------------------------------------
function txFromRow(r) {
  return {
    id: String(r.id),
    type: r.type === 'income' ? 'income' : 'expense',
    amount: round2(r.amount),
    description: r.description || '',
    date: String(r.date || '').slice(0, 10),
    category: r.category || 'other',
    accountId: r.account_id || 'checking',
    paymentMethod: r.payment_method || 'credit',
    status: r.status === 'paid' ? 'paid' : 'pending',
    recurring: Boolean(r.recurring),
    recurringId: r.recurring_id || null,
    isRecurringInstance: false,
    createdBy: r.created_by || null,
    updatedBy: r.updated_by || null,
    updatedAt: r.updated_at || null
  };
}

function txToRow(t) {
  return {
    id: String(t.id),
    casa_id: casaId,
    type: t.type === 'income' ? 'income' : 'expense',
    amount: round2(t.amount),
    description: String(t.description || '').slice(0, 200),
    date: isDateInput(t.date) ? t.date : todayInput(),
    category: t.category || 'other',
    account_id: t.accountId || null,
    payment_method: t.paymentMethod || null,
    status: t.status === 'paid' ? 'paid' : 'pending',
    recurring: Boolean(t.recurring),
    recurring_id: t.recurringId || null
  };
}

function goalFromRow(r) {
  return {
    id: String(r.id),
    title: r.title || '',
    category: r.category || 'other',
    deadline: r.deadline || '',
    target: round2(r.target),
    current: round2(r.current),
    archived: Boolean(r.archived),
    contributions: Array.isArray(r.contributions) ? r.contributions : [],
    createdAt: r.created_at || null,
    updatedBy: r.updated_by || null
  };
}

function goalToRow(g) {
  return {
    id: String(g.id),
    casa_id: casaId,
    title: String(g.title || '').slice(0, 120),
    category: g.category || 'other',
    deadline: g.deadline || null,
    target: round2(g.target),
    current: round2(g.current),
    archived: Boolean(g.archived),
    contributions: Array.isArray(g.contributions) ? g.contributions.slice(0, 500) : []
  };
}

function accountFromRow(r) {
  return { id: String(r.id), name: r.name || 'Conta', type: r.type || 'Conta', color: r.color || '#00b4a0', position: Number(r.position) || 0 };
}

function accountToRow(a) {
  return { id: String(a.id), casa_id: casaId, name: String(a.name || 'Conta').slice(0, 60), type: String(a.type || 'Conta').slice(0, 40), color: a.color || '#00b4a0', position: Number(a.position) || 0 };
}

function memberFromRow(r) {
  return { userId: r.user_id, nome: r.nome || 'Pessoa', cor: r.cor || '#00b4a0', foto: r.foto || null, updatedAt: r.updated_at || null };
}

function memberName(userId) {
  if (!userId) return '';
  if (me && userId === me.id) return 'você';
  return State.members.find(m => m.userId === userId)?.nome || 'Alguém';
}

function authorSuffix(tx) {
  if (State.members.length < 2 || !tx?.updatedBy) return '';
  const name = memberName(tx.updatedBy);
  return ` · ${escapeHtml(name)}`;
}

// ---------------------------------------------------------------------
// Cópia local (abre rápido e funciona sem internet)
// ---------------------------------------------------------------------
function saveCache() {
  if (!me) return;
  try {
    cacheSavedAt = new Date().toISOString();
    localStorage.setItem(lsCacheKey(me.id), JSON.stringify({
      savedAt: cacheSavedAt,
      casaId,
      casaNome: State.casa.nome,
      members: State.members,
      accounts: State.accounts,
      transactions: State.transactions,
      goals: State.goals,
      budgets: State.budgets,
      lastCloudReadAt
    }));
  } catch (error) {
    console.warn('Não foi possível guardar a cópia local:', error);
  }
}

function loadCache() {
  if (!me) return false;
  try {
    const raw = localStorage.getItem(lsCacheKey(me.id));
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.transactions)) return false;
    casaId = data.casaId || casaId;
    State.casa.nome = data.casaNome || State.casa.nome;
    State.members = Array.isArray(data.members) ? data.members : [];
    State.accounts = Array.isArray(data.accounts) && data.accounts.length ? data.accounts : DEFAULT_ACCOUNTS.map(a => ({ ...a }));
    State.transactions = sortTransactionsByDateDesc(data.transactions);
    State.goals = Array.isArray(data.goals) ? data.goals : [];
    State.budgets = { ...emptyBudgets(), ...(data.budgets || {}) };
    lastCloudReadAt = data.lastCloudReadAt || null;
    cacheSavedAt = data.savedAt || null;
    const mine = State.members.find(m => m.userId === me.id);
    if (mine) applyMemberToProfile(mine);
    return true;
  } catch (error) {
    console.warn('Cópia local ilegível:', error);
    return false;
  }
}

function rememberLastUser() {
  try {
    localStorage.setItem(LS_LAST_USER, JSON.stringify({ id: me.id, email: me.email || '' }));
  } catch (_) { /* sem espaço */ }
}

function getLastUser() {
  try { return JSON.parse(localStorage.getItem(LS_LAST_USER) || 'null'); } catch (_) { return null; }
}

// ---------------------------------------------------------------------
// Fila de alterações (gravadas na nuvem assim que houver internet)
// ---------------------------------------------------------------------
function loadQueue() {
  try { queue = JSON.parse(localStorage.getItem(lsQueueKey(me.id)) || '[]'); } catch (_) { queue = []; }
  if (!Array.isArray(queue)) queue = [];
  updateQueueView();
}

function saveQueue() {
  try { localStorage.setItem(lsQueueKey(me.id), JSON.stringify(queue)); } catch (error) { console.warn('Fila não guardada:', error); }
  updateQueueView();
}

function updateQueueView() {
  safeSetText('settings-queue-count', String(queue.length));
  renderDataHealthPanel();
}

function enqueue(op) {
  if (!me) return;
  queue.push({ ...op, opId: newId(), at: new Date().toISOString() });
  saveQueue();
  saveCache();
  if (navigator.onLine && client) {
    setSyncStatus('Enviando para a nuvem...', 'saving');
  } else {
    setSyncStatus('Sem internet. Guardado no aparelho.', 'warn', 'Será enviado assim que a conexão voltar.');
  }
  flushQueue();
}

function isRetryableError(error) {
  if (!navigator.onLine) return true;
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status || 0);
  if (/fetch|network|tempo esgotado|timeout|timed out|load failed|aborted/.test(message)) return true;
  if ([401, 408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (/jwt|token|expired/.test(message)) return true;
  if (error?.code === 'PGRST301') return true;
  return false;
}

async function execOp(op) {
  const table = client.from(op.table);
  switch (op.kind) {
    case 'upsert':
      return withTimeout(table.upsert(op.rows, { onConflict: op.onConflict || 'id' }), 20000, 'Tempo esgotado ao gravar.');
    case 'delete':
      return withTimeout(table.delete().in('id', op.ids).eq('casa_id', casaId), 20000, 'Tempo esgotado ao excluir.');
    case 'deleteWhere':
      return withTimeout(table.delete().eq(op.column, op.value).eq('casa_id', casaId), 20000, 'Tempo esgotado ao excluir.');
    case 'update':
      return withTimeout(table.update(op.patch).match(op.match), 20000, 'Tempo esgotado ao atualizar.');
    default:
      return { error: { message: `Operação desconhecida: ${op.kind}` } };
  }
}

async function flushQueue() {
  if (flushing || !client || !me || !casaId || offlineMode) return;
  if (!navigator.onLine) { setSyncStatus('Sem internet. Guardado no aparelho.', 'warn', `${queue.length} alteração(ões) esperando.`); return; }
  if (!queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const op = queue[0];
      let result;
      try {
        result = await execOp(op);
      } catch (error) {
        result = { error };
      }
      if (result?.error) {
        if (isRetryableError(result.error)) {
          setSyncStatus('Nuvem fora de alcance. Tentando de novo em instantes.', 'warn', String(result.error.message || ''));
          setTimeout(flushQueue, 8000);
          return;
        }
        console.warn('O banco recusou uma alteração:', result.error, op);
        queue.shift();
        saveQueue();
        showToast(`O banco recusou uma alteração: ${result.error.message || 'erro'}`, 'error', 5000);
        continue;
      }
      queue.shift();
      saveQueue();
    }
    setSyncStatus('Tudo sincronizado.', 'ok', `Confirmado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`);
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------
// Status de sincronização na tela
// ---------------------------------------------------------------------
function setSyncStatus(text, mode = 'ok', detail = '') {
  safeSetText('settings-sync-text', text);
  safeSetText('settings-sync-detail', detail);
  const dot = document.getElementById('settings-sync-dot');
  const chip = dot?.closest('.sync-status-chip');
  if (dot) {
    dot.classList.remove('warn', 'off', 'saving');
    if (['warn', 'off', 'saving'].includes(mode)) dot.classList.add(mode);
  }
  if (chip) {
    chip.classList.remove('warn', 'off', 'saving');
    if (['warn', 'off', 'saving'].includes(mode)) chip.classList.add(mode);
  }
  updateLiveIndicator();
  renderDataHealthPanel();
}

function updateLiveIndicator() {
  const dot = document.getElementById('live-indicator');
  const text = document.getElementById('live-text');
  if (!dot || !text) return;
  dot.classList.remove('ok', 'warn', 'off');
  if (offlineMode || !navigator.onLine) {
    dot.classList.add('off');
    text.textContent = queue.length ? `Sem internet · ${queue.length} para enviar` : 'Sem internet · cópia do aparelho';
    dot.title = 'Sem internet';
    return;
  }
  if (realtimeStatus === 'SUBSCRIBED') {
    dot.classList.add('ok');
    text.textContent = State.members.length > 1 ? `Ao vivo com ${otherMembersLabel()}` : 'Ao vivo';
    dot.title = 'Tempo real ligado';
    return;
  }
  dot.classList.add('warn');
  text.textContent = cloudLoaded ? 'Conectando ao tempo real...' : 'Carregando da nuvem...';
  dot.title = 'Conectando';
}

function otherMembersLabel() {
  const others = State.members.filter(m => m.userId !== me?.id).map(m => m.nome);
  if (!others.length) return 'a casa';
  if (others.length === 1) return others[0];
  return `${others.slice(0, -1).join(', ')} e ${others[others.length - 1]}`;
}

function formatDataHealthDate(value) {
  const time = parseTimestamp(value);
  if (!time) return 'Ainda não';
  return new Date(time).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderDataHealthPanel() {
  const container = document.getElementById('settings-data-health');
  if (!container) return;
  const status = document.getElementById('settings-data-health-status');
  const statusText = offlineMode || !navigator.onLine ? 'Sem internet' : queue.length ? 'Enviando' : cloudLoaded ? 'Protegido' : 'Carregando';
  if (status) {
    status.textContent = statusText;
    status.className = `text-xs font-semibold ${statusText === 'Protegido' ? 'text-brand' : statusText === 'Enviando' ? 'text-warning' : 'text-[#86a8b7]'}`;
  }
  safeSetText('settings-cloud-last-sync', formatDataHealthDate(lastCloudReadAt));
  const item = (label, value, note) => `
    <div class="data-health-item">
      <div class="data-health-label">${escapeHtml(label)}</div>
      <div class="data-health-value">${escapeHtml(value)}</div>
      <div class="data-health-note">${escapeHtml(note)}</div>
    </div>`;
  container.innerHTML = [
    item('Cópia no aparelho', formatDataHealthDate(cacheSavedAt), 'Atualizada a cada alteração.'),
    item('Esperando envio', String(queue.length), queue.length ? 'Serão enviadas quando houver internet.' : 'Nada pendente.'),
    item('Nuvem', formatDataHealthDate(lastCloudReadAt), realtimeStatus === 'SUBSCRIBED' ? 'Tempo real ligado.' : 'Tempo real desligado.')
  ].join('');
}

// ---------------------------------------------------------------------
// Supabase: conexão, login, sessão
// ---------------------------------------------------------------------
function hasConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function ensureClient() {
  if (client) return client;
  if (!hasConfig() || !window.supabase?.createClient) return null;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return client;
}

function showShell(which) {
  document.getElementById('setup-shell')?.classList.toggle('hidden', which !== 'setup');
  document.getElementById('auth-shell')?.classList.toggle('hidden', which !== 'auth');
  const appVisible = which === 'app';
  document.getElementById('app')?.classList.toggle('hidden', !appVisible);
  document.getElementById('bottom-nav')?.classList.toggle('hidden', !appVisible);
  document.getElementById('fab')?.classList.toggle('hidden', !appVisible);
  if (!appVisible) toggleSidebar(false);
}

function updateAuthConnectivityState() {
  const offline = !navigator.onLine;
  document.getElementById('auth-offline-card')?.classList.toggle('active', offline);
  ['auth-email', 'auth-password', 'auth-submit-btn'].forEach(id => document.getElementById(id)?.toggleAttribute('disabled', offline));
  if (offline) safeSetText('auth-status', 'Sem internet no momento. Conecte-se para entrar.');
}

function openLoginScreen(statusText = '') {
  showShell('auth');
  updateAuthConnectivityState();
  if (statusText) safeSetText('auth-status', statusText);
  setTimeout(() => document.getElementById('auth-email')?.focus(), 80);
}

function friendlyAuthError(error) {
  const message = String(error?.message || error || '');
  if (/invalid login credentials/i.test(message)) return 'E-mail ou senha incorretos.';
  if (/email not confirmed/i.test(message)) return 'Este e-mail ainda não foi confirmado no Supabase.';
  if (/rate limit|too many/i.test(message)) return 'Muitas tentativas. Aguarde um minuto e tente de novo.';
  if (/fetch|network/i.test(message)) return 'Não consegui falar com o banco. Confira a internet.';
  return message || 'Falha ao entrar.';
}

async function submitAuth(event) {
  event?.preventDefault?.();
  const c = ensureClient();
  if (!c) { safeSetText('auth-status', 'Banco não configurado neste aplicativo.'); return; }
  if (!navigator.onLine) { updateAuthConnectivityState(); return; }
  const email = normalizeEmail(document.getElementById('auth-email')?.value);
  const password = document.getElementById('auth-password')?.value || '';
  const button = document.getElementById('auth-submit-btn');
  safeSetText('auth-status', 'Entrando...');
  if (button) button.disabled = true;
  try {
    const { data, error } = await withTimeout(c.auth.signInWithPassword({ email, password }), 20000, 'Tempo esgotado ao entrar.');
    if (error) throw error;
    if (!data?.session?.user) throw new Error('Não foi possível abrir a sessão.');
    safeSetText('auth-status', 'Conta conectada. Carregando a casa...');
    // O onAuthStateChange cuida do resto (SIGNED_IN).
  } catch (error) {
    safeSetText('auth-status', friendlyAuthError(error));
  } finally {
    if (button) button.disabled = false;
  }
}

async function forgotPassword() {
  const c = ensureClient();
  if (!c) return;
  const email = normalizeEmail(document.getElementById('auth-email')?.value);
  if (!email) { safeSetText('auth-status', 'Digite seu e-mail no campo acima e toque de novo em "Esqueci minha senha".'); return; }
  safeSetText('auth-status', 'Enviando e-mail de recuperação...');
  try {
    const redirectTo = `${location.origin}${location.pathname}`;
    const { error } = await withTimeout(c.auth.resetPasswordForEmail(email, { redirectTo }), 20000, 'Tempo esgotado.');
    if (error) throw error;
    safeSetText('auth-status', `Enviei um link para ${email}. Abra o e-mail neste aparelho e escolha a nova senha.`);
  } catch (error) {
    safeSetText('auth-status', friendlyAuthError(error));
  }
}

async function logout() {
  if (queue.length) {
    const ok = await askConfirm({
      title: 'Alterações ainda não enviadas',
      message: `Existem ${queue.length} alteração(ões) esperando internet. Se sair agora, elas são perdidas. Sair mesmo assim?`,
      okLabel: 'Sair e perder',
      danger: true
    });
    if (!ok) return;
  }
  const c = ensureClient();
  teardownRealtime();
  try { if (c) await withTimeout(c.auth.signOut(), 10000, 'Tempo esgotado ao sair.'); } catch (error) { console.warn('Falha ao encerrar sessão:', error); }
  try { if (me) { localStorage.removeItem(lsCacheKey(me.id)); localStorage.removeItem(lsQueueKey(me.id)); } localStorage.removeItem(LS_LAST_USER); } catch (_) { /* ok */ }
  resetSessionState();
  openLoginScreen('Sessão encerrada. Entre novamente para ver os dados da casa.');
}

function resetSessionState() {
  bootToken++;
  me = null;
  myMember = null;
  casaId = null;
  queue = [];
  cloudLoaded = false;
  offlineMode = false;
  lastCloudReadAt = null;
  cacheSavedAt = null;
  State.transactions = [];
  State.goals = [];
  State.accounts = DEFAULT_ACCOUNTS.map(a => ({ ...a }));
  State.budgets = emptyBudgets();
  State.members = [];
  State.profile = { name: '', email: '', photo: null, color: '#00b4a0' };
  realtimeStatus = 'off';
  renderAll();
}

async function initAuth() {
  const c = ensureClient();
  if (!c) {
    // Sem biblioteca ou sem configuração: tenta abrir a cópia do aparelho.
    if (!hasConfig()) { showShell('setup'); return; }
    if (!enterOfflineModeIfPossible()) openLoginScreen('A biblioteca do banco não carregou. Confira a internet e abra de novo.');
    return;
  }

  let gotEvent = false;
  c.auth.onAuthStateChange((event, session) => {
    gotEvent = true;
    if (event === 'PASSWORD_RECOVERY') {
      setTimeout(() => openPasswordChangeModal(), 0);
    }
    if (isChangingPassword && event === 'USER_UPDATED') return;
    if (session?.user) {
      if (event === 'TOKEN_REFRESHED' && me?.id === session.user.id) { me = session.user; return; }
      if (me?.id === session.user.id && cloudLoaded) { me = session.user; return; }
      setTimeout(() => bootstrapSession(session.user), 0);
      return;
    }
    if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
      if (me && event === 'INITIAL_SESSION') return;
      if (!navigator.onLine && enterOfflineModeIfPossible()) return;
      resetSessionState();
      openLoginScreen('Entre com sua conta para ver os dados da casa.');
    }
  });

  // Se nada acontecer em alguns segundos (sem internet, sessão travada), abre a cópia local.
  setTimeout(() => {
    if (!gotEvent && !me) {
      if (!enterOfflineModeIfPossible()) openLoginScreen('Entre com sua conta para ver os dados da casa.');
    }
  }, 4000);
}

function enterOfflineModeIfPossible() {
  const last = getLastUser();
  if (!last?.id) return false;
  me = { id: last.id, email: last.email || '' };
  if (!loadCache()) { me = null; return false; }
  loadQueue();
  offlineMode = true;
  showShell('app');
  renderAll();
  setSyncStatus('Sem internet. Mostrando a cópia deste aparelho.', 'off', 'As alterações feitas agora serão enviadas quando a conexão voltar.');
  return true;
}

// ---------------------------------------------------------------------
// Carregar a casa (cópia local primeiro, nuvem em seguida)
// ---------------------------------------------------------------------
async function fetchAll(table) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await withTimeout(
      client.from(table).select('*').eq('casa_id', casaId).order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1),
      30000,
      `Tempo esgotado ao ler ${table}.`
    );
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function applyMemberToProfile(member) {
  State.profile.name = member.nome || State.profile.name;
  State.profile.photo = member.foto || null;
  State.profile.color = member.cor || '#00b4a0';
}

async function bootstrapSession(user) {
  const token = ++bootToken;
  const switching = me && me.id !== user.id;
  if (switching) resetSessionState();
  me = user;
  State.profile.email = user.email || '';
  offlineMode = false;
  rememberLastUser();
  showShell('app');
  loadQueue();
  if (loadCache()) renderAll();
  setSyncStatus('Carregando da nuvem...', 'saving');
  updateLiveIndicator();

  try {
    const { data: members, error: membersError } = await withTimeout(client.from('membros').select('*'), 30000, 'Tempo esgotado ao ler os membros.');
    if (token !== bootToken) return;
    if (membersError) throw membersError;
    myMember = (members || []).find(m => m.user_id === me.id) || null;
    if (!myMember) {
      setSyncStatus('Sua conta ainda não está na casa.', 'off', 'Rode o arquivo supabase_v2.sql no SQL Editor do Supabase e entre de novo.');
      showToast('Sua conta ainda não entrou na casa. Rode o SQL do banco e entre de novo.', 'error', 6000);
      return;
    }
    casaId = myMember.casa_id;
    State.members = (members || []).map(memberFromRow);
    applyMemberToProfile(memberFromRow(myMember));

    const [casaRows, contas, lancamentos, metas, orcamentos] = await Promise.all([
      withTimeout(client.from('casas').select('*').eq('id', casaId).limit(1), 30000, 'Tempo esgotado ao ler a casa.'),
      fetchAll('contas'),
      fetchAll('lancamentos'),
      fetchAll('metas'),
      fetchAll('orcamentos')
    ]);
    if (token !== bootToken) return;
    if (casaRows.error) throw casaRows.error;
    State.casa = { id: casaId, nome: casaRows.data?.[0]?.nome || CONFIG.nomeDaCasa || 'Nossa casa' };
    State.accounts = contas.length ? contas.map(accountFromRow).sort((a, b) => a.position - b.position) : DEFAULT_ACCOUNTS.map(a => ({ ...a }));
    // Mantém as alterações ainda não enviadas por cima do que veio da nuvem.
    State.transactions = sortTransactionsByDateDesc(mergePendingTransactions(lancamentos.map(txFromRow)));
    State.goals = mergePendingGoals(metas.map(goalFromRow));
    State.budgets = emptyBudgets();
    orcamentos.forEach(o => { State.budgets[o.category] = round2(o.amount); });
    cloudLoaded = true;
    lastCloudReadAt = new Date().toISOString();
    saveCache();
    renderAll();
    setSyncStatus(queue.length ? 'Enviando alterações guardadas...' : 'Tudo sincronizado.', queue.length ? 'saving' : 'ok');
    subscribeRealtime();
    await flushQueue();
    if (token !== bootToken) return;
    handleStartupShortcuts();
    offerLegacyImport(false);
    remindDueBills();
  } catch (error) {
    if (token !== bootToken) return;
    console.error('Falha ao carregar a nuvem:', error);
    const hasLocal = State.transactions.length > 0 || State.goals.length > 0;
    setSyncStatus(
      hasLocal ? 'Nuvem indisponível. Mostrando a cópia deste aparelho.' : 'Não consegui carregar a nuvem.',
      'off',
      String(error?.message || error)
    );
    if (!hasLocal) showToast(`Não consegui carregar os dados: ${error?.message || error}`, 'error', 6000);
    scheduleRealtimeRetry(15000);
  }
}

function mergePendingTransactions(cloudTxs) {
  const byId = new Map(cloudTxs.map(t => [t.id, t]));
  queue.forEach(op => {
    if (op.table !== 'lancamentos') return;
    if (op.kind === 'upsert') op.rows.forEach(row => byId.set(String(row.id), { ...(byId.get(String(row.id)) || {}), ...txFromRow(row), updatedBy: me?.id || null }));
    if (op.kind === 'delete') op.ids.forEach(id => byId.delete(String(id)));
    if (op.kind === 'deleteWhere' && op.column === 'recurring_id') {
      [...byId.values()].filter(t => t.recurringId === op.value).forEach(t => byId.delete(t.id));
    }
  });
  return [...byId.values()];
}

function mergePendingGoals(cloudGoals) {
  const byId = new Map(cloudGoals.map(g => [g.id, g]));
  queue.forEach(op => {
    if (op.table !== 'metas') return;
    if (op.kind === 'upsert') op.rows.forEach(row => byId.set(String(row.id), { ...(byId.get(String(row.id)) || {}), ...goalFromRow(row) }));
    if (op.kind === 'delete') op.ids.forEach(id => byId.delete(String(id)));
  });
  return [...byId.values()];
}

async function syncNow() {
  if (!client || !me) { showToast('Entre na conta para sincronizar.', 'error'); return; }
  if (!navigator.onLine) { showToast('Sem internet agora. Assim que voltar, envio tudo sozinho.', 'error'); return; }
  setSyncStatus('Sincronizando...', 'saving');
  try {
    await flushQueue();
    await reloadFromCloud();
    showToast('Sincronizado com a nuvem.');
  } catch (error) {
    showToast(`Não consegui sincronizar: ${error?.message || error}`, 'error');
  }
}

async function reloadFromCloud() {
  if (!client || !me || !casaId) return;
  const token = bootToken;
  const [members, contas, lancamentos, metas, orcamentos] = await Promise.all([
    withTimeout(client.from('membros').select('*'), 30000, 'Tempo esgotado ao ler os membros.'),
    fetchAll('contas'), fetchAll('lancamentos'), fetchAll('metas'), fetchAll('orcamentos')
  ]);
  if (token !== bootToken) return;
  if (members.error) throw members.error;
  State.members = (members.data || []).map(memberFromRow);
  const mine = State.members.find(m => m.userId === me.id);
  if (mine) applyMemberToProfile(mine);
  if (contas.length) State.accounts = contas.map(accountFromRow).sort((a, b) => a.position - b.position);
  State.transactions = sortTransactionsByDateDesc(mergePendingTransactions(lancamentos.map(txFromRow)));
  State.goals = mergePendingGoals(metas.map(goalFromRow));
  State.budgets = emptyBudgets();
  orcamentos.forEach(o => { State.budgets[o.category] = round2(o.amount); });
  cloudLoaded = true;
  lastCloudReadAt = new Date().toISOString();
  saveCache();
  renderAll();
  setSyncStatus(queue.length ? 'Enviando alterações guardadas...' : 'Tudo sincronizado.', queue.length ? 'saving' : 'ok');
}

function handleStartupShortcuts() {
  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'new') openModalTx();
  if (params.get('page')) openPage(params.get('page'));
  if (params.has('action') || params.has('page')) history.replaceState(null, '', location.pathname);
}

// ---------------------------------------------------------------------
// Tempo real
// ---------------------------------------------------------------------
function subscribeRealtime() {
  if (!client || !casaId) return;
  teardownRealtime();
  channel = client.channel(`casa-${casaId}`);
  ['lancamentos', 'metas', 'contas', 'orcamentos', 'membros'].forEach(table => {
    channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `casa_id=eq.${casaId}` }, payload => onRealtime(table, payload));
  });
  channel.subscribe((status) => {
    realtimeStatus = status;
    updateLiveIndicator();
    renderDataHealthPanel();
    if (status === 'SUBSCRIBED') {
      clearTimeout(realtimeRetryTimer);
      // Pode ter perdido algo enquanto estava desligado: relê a nuvem sem travar a tela.
      reloadFromCloud().catch(error => console.warn('Releitura após reconectar falhou:', error));
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      scheduleRealtimeRetry(10000);
    }
  });
}

function teardownRealtime() {
  clearTimeout(realtimeRetryTimer);
  if (channel && client) {
    try { client.removeChannel(channel); } catch (_) { /* ok */ }
  }
  channel = null;
  realtimeStatus = 'off';
  updateLiveIndicator();
}

function scheduleRealtimeRetry(ms) {
  clearTimeout(realtimeRetryTimer);
  realtimeRetryTimer = setTimeout(() => {
    if (!me || !client || !navigator.onLine) return;
    if (!casaId) { bootstrapSession(me); return; }
    subscribeRealtime();
    flushQueue();
  }, ms);
}

function onRealtime(table, payload) {
  const eventType = payload?.eventType;
  const row = eventType === 'DELETE' ? payload.old : payload.new;
  if (!row) return;
  const author = row.updated_by || row.created_by || null;
  const byMe = author && me && author === me.id;

  switch (table) {
    case 'lancamentos': {
      if (eventType === 'DELETE') {
        State.transactions = State.transactions.filter(t => t.id !== String(row.id));
      } else {
        const tx = txFromRow(row);
        const idx = State.transactions.findIndex(t => t.id === tx.id);
        if (idx > -1) State.transactions[idx] = tx; else State.transactions.push(tx);
        State.transactions = sortTransactionsByDateDesc(State.transactions);
      }
      break;
    }
    case 'metas': {
      if (eventType === 'DELETE') {
        State.goals = State.goals.filter(g => g.id !== String(row.id));
      } else {
        const goal = goalFromRow(row);
        const idx = State.goals.findIndex(g => g.id === goal.id);
        if (idx > -1) State.goals[idx] = goal; else State.goals.push(goal);
      }
      break;
    }
    case 'contas': {
      if (eventType === 'DELETE') {
        State.accounts = State.accounts.filter(a => a.id !== String(row.id));
      } else {
        const account = accountFromRow(row);
        const idx = State.accounts.findIndex(a => a.id === account.id);
        if (idx > -1) State.accounts[idx] = account; else State.accounts.push(account);
        State.accounts.sort((a, b) => a.position - b.position);
      }
      if (!State.accounts.length) State.accounts = DEFAULT_ACCOUNTS.map(a => ({ ...a }));
      populateAccountOptions();
      break;
    }
    case 'orcamentos': {
      if (eventType === 'DELETE') State.budgets[row.category] = 0;
      else State.budgets[row.category] = round2(row.amount);
      break;
    }
    case 'membros': {
      if (eventType === 'DELETE') {
        State.members = State.members.filter(m => m.userId !== row.user_id);
      } else {
        const member = memberFromRow(row);
        const idx = State.members.findIndex(m => m.userId === member.userId);
        if (idx > -1) State.members[idx] = member; else State.members.push(member);
        if (member.userId === me?.id) applyMemberToProfile(member);
      }
      break;
    }
    default:
      return;
  }

  lastCloudReadAt = new Date().toISOString();
  saveCache();
  scheduleRender();
  if (!byMe && author) collectNotice(table, eventType, row, author);
}

function collectNotice(table, eventType, row, author) {
  if (!notifPrefs.outros) return;
  noticeBuffer.push({ table, eventType, row, author });
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(flushNotices, 500);
}

function flushNotices() {
  const items = noticeBuffer.splice(0);
  if (!items.length) return;
  const who = memberName(items[0].author);
  const whoCap = who.charAt(0).toUpperCase() + who.slice(1);
  let title = `${whoCap} atualizou a casa`;
  let body = `${items.length} alterações`;
  if (items.length === 1) {
    const { table, eventType, row } = items[0];
    if (table === 'lancamentos') {
      const kind = row.type === 'income' ? 'a receita' : 'a despesa';
      const value = formatMoney(row.amount);
      if (eventType === 'INSERT') { title = `${whoCap} lançou ${kind}`; body = `${row.description} · ${value} · ${formatDate(row.date)}`; }
      else if (eventType === 'DELETE') { title = `${whoCap} excluiu ${kind}`; body = `${row.description} · ${value}`; }
      else if (row.status === 'paid') { title = `${whoCap} marcou como ${row.type === 'income' ? 'recebido' : 'pago'}`; body = `${row.description} · ${value}`; }
      else { title = `${whoCap} alterou ${kind}`; body = `${row.description} · ${value} · ${formatDate(row.date)}`; }
    } else if (table === 'metas') {
      title = eventType === 'DELETE' ? `${whoCap} excluiu uma meta` : `${whoCap} atualizou a meta`;
      body = `${row.title} · ${formatMoney(row.current)} de ${formatMoney(row.target)}`;
    } else if (table === 'contas') {
      title = `${whoCap} alterou as contas`;
      body = row.name || '';
    } else if (table === 'orcamentos') {
      title = `${whoCap} alterou o orçamento`;
      body = `${getCategory(row.category).name}: ${formatMoney(row.amount)}`;
    } else if (table === 'membros') {
      title = `${whoCap} atualizou o perfil`;
      body = row.nome || '';
    }
  } else {
    const txCount = items.filter(i => i.table === 'lancamentos').length;
    if (txCount === items.length) {
      const inserts = items.filter(i => i.eventType === 'INSERT').length;
      if (inserts === items.length) { title = `${whoCap} lançou ${inserts} itens`; body = items[0].row.description ? `${items[0].row.description} e outros` : ''; }
      else body = `${items.length} alterações em lançamentos`;
    }
  }
  showToast(body ? `${title}: ${body}` : title, 'info', 5000);
  showDeviceNotification(title, body);
}

// ---------------------------------------------------------------------
// Avisos no aparelho
// ---------------------------------------------------------------------
function loadNotifPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_NOTIF) || '{}');
    return { enabled: Boolean(saved.enabled), outros: saved.outros !== false, vencimentos: saved.vencimentos !== false, lastDueReminder: saved.lastDueReminder || '' };
  } catch (_) {
    return { enabled: false, outros: true, vencimentos: true, lastDueReminder: '' };
  }
}

function saveNotifPrefs() {
  try { localStorage.setItem(LS_NOTIF, JSON.stringify(notifPrefs)); } catch (_) { /* ok */ }
  renderNotifSettings();
}

function renderNotifSettings() {
  const status = document.getElementById('notif-status');
  const button = document.getElementById('notif-enable-btn');
  const supported = 'Notification' in window;
  const permission = supported ? Notification.permission : 'unsupported';
  let text = 'Desligados';
  let cls = 'text-xs font-semibold text-[#86a8b7]';
  if (!supported) text = 'Sem suporte neste navegador';
  else if (permission === 'denied') { text = 'Bloqueados pelo navegador'; cls = 'text-xs font-semibold text-expense'; }
  else if (permission === 'granted' && notifPrefs.enabled) { text = 'Ligados'; cls = 'text-xs font-semibold text-brand'; }
  if (status) { status.textContent = text; status.className = cls; }
  if (button) {
    button.textContent = permission === 'granted' && notifPrefs.enabled ? 'Desligar avisos neste aparelho' : 'Ligar avisos neste aparelho';
    button.disabled = !supported || permission === 'denied';
    button.style.opacity = button.disabled ? '0.6' : '';
  }
  document.getElementById('notif-toggle-outros')?.classList.toggle('active', notifPrefs.outros);
  document.getElementById('notif-toggle-vencimentos')?.classList.toggle('active', notifPrefs.vencimentos);
}

async function enableDeviceNotifications() {
  if (!('Notification' in window)) { showToast('Este navegador não mostra notificações.', 'error'); return; }
  if (Notification.permission === 'granted' && notifPrefs.enabled) {
    notifPrefs.enabled = false;
    saveNotifPrefs();
    showToast('Avisos desligados neste aparelho.');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      notifPrefs.enabled = true;
      saveNotifPrefs();
      showToast('Avisos ligados. Você será avisado do que a outra pessoa fizer.');
      showDeviceNotification('Avisos ligados', 'O Controle Financeiro vai avisar por aqui.', { force: true });
    } else {
      saveNotifPrefs();
      showToast('Permissão não concedida pelo navegador.', 'error');
    }
  } catch (error) {
    showToast(`Não consegui pedir a permissão: ${error?.message || error}`, 'error');
  }
}

function toggleNotifPref(key) {
  if (!['outros', 'vencimentos'].includes(key)) return;
  notifPrefs[key] = !notifPrefs[key];
  saveNotifPrefs();
}

async function showDeviceNotification(title, body, { force = false } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !notifPrefs.enabled) return;
  if (!force && !document.hidden) return; // com o app na frente, o aviso na tela já basta
  const options = { body, icon: 'logo-192.png', badge: 'logo-192.png', tag: `gplan-${Date.now()}`, lang: 'pt-BR' };
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options);
  } catch (error) {
    console.warn('Notificação não exibida:', error);
  }
}

function getDueExpenses() {
  const today = todayInput();
  return State.transactions.filter(t => t.type === 'expense' && t.status === 'pending' && t.date && t.date <= today);
}

function updateDueAlerts() {
  const box = document.getElementById('due-alerts');
  if (!box) return;
  const due = getDueExpenses();
  if (!due.length) { box.classList.add('hidden'); return; }
  const total = due.reduce((s, t) => s + t.amount, 0);
  const overdue = due.filter(t => t.date < todayInput()).length;
  safeSetText('due-alerts-title', due.length === 1 ? '1 conta vencendo ou atrasada' : `${due.length} contas vencendo ou atrasadas`);
  safeSetText('due-alerts-detail', `${formatMoney(total)} no total${overdue ? ` · ${overdue} já ${overdue === 1 ? 'passou' : 'passaram'} da data` : ''}`);
  box.classList.remove('hidden');
}

function remindDueBills() {
  if (!notifPrefs.vencimentos) return;
  const today = todayInput();
  if (notifPrefs.lastDueReminder === today) return;
  const due = getDueExpenses();
  if (!due.length) return;
  notifPrefs.lastDueReminder = today;
  saveNotifPrefs();
  const total = due.reduce((s, t) => s + t.amount, 0);
  showToast(`${due.length} conta(s) vencendo ou atrasada(s), somando ${formatMoney(total)}.`, 'info', 6000);
}

// ---------------------------------------------------------------------
// Importar dados da versão antiga (guardados no navegador) e backups
// ---------------------------------------------------------------------
function extractStatePayload(raw) {
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed?.app_state || parsed?.state || parsed?.data?.app_state || parsed?.data?.state || parsed;
}

function countPayloadTransactions(payload) {
  return Array.isArray(payload?.transactions) ? payload.transactions.filter(t => t && !t.isRecurringInstance).length : 0;
}

function findLegacyData() {
  const candidates = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      const isLegacy = key === 'golbuy_v6' || /^golbuy_v\d+:/.test(key);
      if (!isLegacy) continue;
      if (key.endsWith(':meta') || key.includes(':quick_access') || key.includes(':last_active_email')) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        const payload = extractStatePayload(parsed);
        const count = countPayloadTransactions(payload);
        if (!count) continue;
        candidates.push({ key, payload, count, goals: Array.isArray(payload.goals) ? payload.goals.length : 0, at: parseTimestamp(parsed?.created_at || parsed?.updated_at || parsed?.exported_at) });
      } catch (_) { /* chave ilegível */ }
    }
  } catch (_) { /* sem localStorage */ }
  candidates.sort((a, b) => (b.count - a.count) || (b.at - a.at));
  return candidates[0] || null;
}

function updateLegacyCard() {
  const card = document.getElementById('legacy-import-card');
  if (!card) return;
  legacyCandidate = findLegacyData();
  card.classList.toggle('hidden', !legacyCandidate);
  if (legacyCandidate) {
    safeSetText('legacy-import-text', `Encontrei ${legacyCandidate.count} lançamentos e ${legacyCandidate.goals} metas da versão antiga guardados neste aparelho.`);
  }
}

async function offerLegacyImport(manual = false) {
  updateLegacyCard();
  if (!legacyCandidate) { if (manual) showToast('Não há dados da versão antiga neste aparelho.', 'error'); return; }
  if (!manual && State.transactions.length > 0) return; // a casa já tem dados; só por pedido
  const ok = await askConfirm({
    title: 'Trazer os dados antigos?',
    message: `Encontrei ${legacyCandidate.count} lançamentos e ${legacyCandidate.goals} metas da versão antiga neste aparelho. Quer importar tudo para a casa agora?`,
    okLabel: 'Importar'
  });
  if (!ok) return;
  await importPayload(legacyCandidate.payload, 'versão antiga');
}

async function importPayload(payload, sourceLabel = 'backup') {
  if (!me || !casaId) { showToast('Entre na conta e aguarde a casa carregar antes de importar.', 'error'); return; }
  const transactions = Array.isArray(payload.transactions) ? payload.transactions.filter(t => t && !t.isRecurringInstance) : [];
  const goals = Array.isArray(payload.goals) ? payload.goals : [];
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const budgets = payload.budgets && typeof payload.budgets === 'object' ? payload.budgets : {};

  // Contas que não existem ainda
  const knownAccountIds = new Set(State.accounts.map(a => a.id));
  const newAccounts = accounts.filter(a => a?.id && !knownAccountIds.has(String(a.id))).map((a, index) => ({
    id: String(a.id), name: a.name || 'Conta', type: a.type || 'Conta', color: a.color || '#00b4a0', position: State.accounts.length + index
  }));
  newAccounts.forEach(a => { State.accounts.push(a); knownAccountIds.add(a.id); });
  if (newAccounts.length) enqueue({ table: 'contas', kind: 'upsert', rows: newAccounts.map(accountToRow) });

  const existingTxIds = new Set(State.transactions.map(t => t.id));
  const txs = transactions.map(t => ({
    id: String(t.id || newId()),
    type: t.type === 'income' ? 'income' : 'expense',
    amount: round2(t.amount),
    description: t.description || t.title || 'Lançamento',
    date: isDateInput(t.date) ? t.date : toDateInputValue(parseLocalDate(t.date) || new Date()),
    category: t.category || 'other',
    accountId: knownAccountIds.has(String(t.accountId)) ? String(t.accountId) : (State.accounts[0]?.id || 'checking'),
    paymentMethod: t.paymentMethod || 'credit',
    status: t.status === 'paid' ? 'paid' : 'pending',
    recurring: Boolean(t.recurring),
    recurringId: t.recurringId || null,
    isRecurringInstance: false,
    updatedBy: me.id
  })).filter(t => !existingTxIds.has(t.id));
  txs.forEach(t => State.transactions.push(t));
  State.transactions = sortTransactionsByDateDesc(State.transactions);
  for (let i = 0; i < txs.length; i += 200) {
    enqueue({ table: 'lancamentos', kind: 'upsert', rows: txs.slice(i, i + 200).map(txToRow) });
  }

  const existingGoalIds = new Set(State.goals.map(g => g.id));
  const newGoals = goals.filter(g => g?.id && !existingGoalIds.has(String(g.id))).map(g => ({
    id: String(g.id), title: g.title || 'Meta', category: g.category || 'other', deadline: g.deadline || '',
    target: round2(g.target), current: round2(g.current), archived: Boolean(g.archived),
    contributions: Array.isArray(g.contributions) ? g.contributions : [], createdAt: g.createdAt || new Date().toISOString()
  }));
  newGoals.forEach(g => State.goals.push(g));
  if (newGoals.length) enqueue({ table: 'metas', kind: 'upsert', rows: newGoals.map(goalToRow) });

  const budgetRows = Object.entries(budgets).filter(([, v]) => Number(v) > 0).map(([category, amount]) => ({ casa_id: casaId, category, amount: round2(amount) }));
  budgetRows.forEach(b => { State.budgets[b.category] = b.amount; });
  if (budgetRows.length) enqueue({ table: 'orcamentos', kind: 'upsert', rows: budgetRows, onConflict: 'casa_id,category' });

  saveCache();
  populateAccountOptions();
  if (txs.length) focusViewsOnTransactionMonth();
  renderAll();
  updateLegacyCard();
  showToast(`Importei ${txs.length} lançamentos e ${newGoals.length} metas da ${sourceLabel}.`, 'success', 5000);
}

function focusViewsOnTransactionMonth() {
  const txs = State.transactions.filter(t => parseLocalDate(t.date));
  if (!txs.length) return;
  const now = new Date();
  const currentMonthTx = txs.find(t => { const d = parseLocalDate(t.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const base = currentMonthTx ? parseLocalDate(currentMonthTx.date) : parseLocalDate(sortTransactionsByDateDesc(txs)[0].date);
  const focus = new Date(base.getFullYear(), base.getMonth(), 1);
  State.dashboardPeriod = 'custom';
  State.dashboardCustomDate = new Date(focus);
  State.txCustomDate = new Date(focus);
  State.reportCustomDate = new Date(focus);
  State.controlPeriod = 'custom';
  State.controlCustomDate = new Date(focus);
  const controlLabel = document.getElementById('control-period-label');
  if (controlLabel) controlLabel.textContent = getMonthLabel(focus);
  calDate = new Date(focus);
  initTxDatePicker();
  initControlDatePicker();
  initReportDatePicker();
}

function exportData() {
  const data = JSON.stringify({
    app: 'Controle Financeiro',
    type: 'backup',
    version: APP_VERSION,
    exported_at: new Date().toISOString(),
    casa: State.casa.nome,
    email: me?.email || '',
    app_state: {
      transactions: State.transactions,
      goals: State.goals,
      accounts: State.accounts,
      budgets: State.budgets
    }
  }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `controle_financeiro_backup_${todayInput()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Cópia de segurança exportada!');
}

function importData(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (loadEvent) => {
    try {
      const parsed = JSON.parse(String(loadEvent.target?.result || '{}'));
      const payload = extractStatePayload(parsed);
      const count = countPayloadTransactions(payload);
      const goals = Array.isArray(payload?.goals) ? payload.goals.length : 0;
      if (!payload || (!count && !goals)) throw new Error('Arquivo sem dados reconhecíveis do Controle Financeiro.');
      const ok = await askConfirm({
        title: 'Importar cópia de segurança?',
        message: `O arquivo tem ${count} lançamentos e ${goals} metas. Lançamentos já existentes (mesmo código) não são duplicados.`,
        okLabel: 'Importar'
      });
      if (!ok) return;
      await importPayload(payload, 'cópia de segurança');
    } catch (error) {
      console.error('Falha ao importar backup:', error);
      showToast(error?.message || 'Não foi possível importar este arquivo.', 'error');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------
// Cálculos financeiros
// ---------------------------------------------------------------------
function filterByDateRange(transactions, targetDate, mode = 'month') {
  const target = parseLocalDate(targetDate) || new Date();
  const tYear = target.getFullYear();
  const tMonth = target.getMonth();
  const tDay = target.getDate();
  return transactions.filter(t => {
    const txDate = parseLocalDate(t.date);
    if (!txDate) return false;
    if (mode === 'month') return txDate.getMonth() === tMonth && txDate.getFullYear() === tYear;
    if (mode === 'day') return txDate.getDate() === tDay && txDate.getMonth() === tMonth && txDate.getFullYear() === tYear;
    return false;
  });
}

function filterByPeriod(transactions, period, customDate = null) {
  const now = parseLocalDate(customDate) || new Date();
  return transactions.filter(t => {
    const txDate = parseLocalDate(t.date);
    if (!txDate) return false;
    if (period === 'month' || period === 'custom') return txDate.getMonth() === now.getMonth() && txDate.getFullYear() === now.getFullYear();
    if (period === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return txDate >= weekAgo && txDate <= new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    }
    if (period === 'year') return txDate.getFullYear() === now.getFullYear();
    return true;
  });
}

function getMonthTransactions(date) {
  return filterByDateRange(State.transactions, date, 'month');
}

function calculateAccountBalances(transactions) {
  return State.accounts.map(account => {
    const balance = transactions.reduce((sum, tx) => {
      if ((tx.accountId || State.accounts[0]?.id) !== account.id) return sum;
      return sum + (tx.type === 'income' ? tx.amount : -tx.amount);
    }, 0);
    return { ...account, balance };
  });
}

function getBudgetSummary(transactions) {
  return State.categories.expense.map(category => {
    const spent = transactions.filter(tx => tx.type === 'expense' && tx.category === category.id).reduce((sum, tx) => sum + tx.amount, 0);
    const budget = Number(State.budgets?.[category.id] || 0);
    return { ...category, spent, budget, remaining: Math.max(0, budget - spent), percent: budget > 0 ? (spent / budget) * 100 : 0 };
  });
}

function buildMonthlyHealth(transactions) {
  const sum = (filter) => transactions.filter(filter).reduce((s, tx) => s + tx.amount, 0);
  const paidIncome = sum(tx => tx.type === 'income' && tx.status === 'paid');
  const paidExpense = sum(tx => tx.type === 'expense' && tx.status === 'paid');
  const pendingIncome = sum(tx => tx.type === 'income' && tx.status === 'pending');
  const pendingExpense = sum(tx => tx.type === 'expense' && tx.status === 'pending');
  const realBalance = paidIncome - paidExpense;
  const committed = Math.max(0, pendingExpense - pendingIncome);
  return { realBalance, committed, free: realBalance - committed, paidIncome, paidExpense, pendingIncome, pendingExpense };
}

function buildDashboardInsights(transactions) {
  const monthHealth = buildMonthlyHealth(transactions);
  const budgetSummary = getBudgetSummary(transactions).filter(item => item.budget > 0);
  const exceeded = budgetSummary.filter(item => item.percent > 100).sort((a, b) => b.percent - a.percent);
  const highUsage = budgetSummary.filter(item => item.percent >= 80 && item.percent <= 100).sort((a, b) => b.percent - a.percent);
  const biggest = getBudgetSummary(transactions).sort((a, b) => b.spent - a.spent)[0];
  const insights = [];
  if (monthHealth.free < 0) insights.push(`O saldo livre do período está negativo em ${formatMoney(Math.abs(monthHealth.free))}. Vale segurar novas despesas até fechar o mês.`);
  if (exceeded[0]) insights.push(`O orçamento de ${exceeded[0].name} estourou: ${exceeded[0].percent.toFixed(0)}% usado, ${formatMoney(exceeded[0].spent)} no mês.`);
  else if (highUsage[0]) insights.push(`${highUsage[0].name} já consumiu ${highUsage[0].percent.toFixed(0)}% do limite mensal.`);
  if (monthHealth.pendingExpense > 0 || monthHealth.pendingIncome > 0) insights.push(`Existem ${formatMoney(monthHealth.pendingExpense)} a pagar e ${formatMoney(monthHealth.pendingIncome)} a receber no período.`);
  if (biggest && biggest.spent > 0) insights.push(`A categoria com maior peso no mês foi ${biggest.name}, com ${formatMoney(biggest.spent)}.`);
  if (!insights.length) insights.push('Sem sinais de risco no período. A movimentação está equilibrada.');
  return insights.slice(0, 4);
}

function buildMonthlyProfitSummary(transactions) {
  const monthly = {};
  transactions.forEach(t => {
    const date = parseLocalDate(t.date);
    if (!date) return;
    const key = getMonthKeyFromDate(date);
    if (!monthly[key]) monthly[key] = { key, label: date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }), income: 0, expense: 0, profit: 0 };
    if (t.type === 'income') monthly[key].income += Number(t.amount || 0);
    if (t.type === 'expense') monthly[key].expense += Number(t.amount || 0);
    monthly[key].profit = monthly[key].income - monthly[key].expense;
  });
  const months = Object.values(monthly).sort((a, b) => b.key.localeCompare(a.key));
  const totalProfit = months.reduce((sum, item) => sum + item.profit, 0);
  return { months, totalProfit, averageProfit: months.length ? totalProfit / months.length : 0 };
}

function buildRecurringSeries(baseTx) {
  const startDate = parseLocalDate(baseTx?.date) || new Date();
  const startDay = startDate.getDate();
  const recurringId = baseTx.recurringId || `${baseTx.id || newId()}_r`;
  const series = [];
  for (let i = 0; i < RECORRENCIA_MESES; i += 1) {
    const monthStart = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(startDay, lastDay));
    const suffix = `${monthStart.getFullYear()}_${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
    series.push({
      ...baseTx,
      id: i === 0 ? String(baseTx.id || `${recurringId}_${suffix}`) : `${recurringId}_${suffix}`,
      date: toDateInputValue(date),
      recurring: true,
      recurringId,
      isRecurringInstance: false
    });
  }
  return series;
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAll, 120);
}

function renderAll() {
  updateDashboard();
  renderTransactions();
  renderControlPage();
  renderCalendar();
  renderGoals();
  renderReports();
  renderSettingsAccounts();
  renderBudgetSettings();
  renderMembers();
  renderDataHealthPanel();
  updateAllAvatars();
  updateDueAlerts();
  updateLiveIndicator();
  safeSetText('sidebar-casa-name', State.casa.nome);
  safeSetText('casa-nome', State.casa.nome);
}

function closeAllDropdowns() {
  document.querySelectorAll('[id^="dropdown-"]').forEach(d => d.classList.add('hidden'));
}

function txIconHtml(type, size = 'w-5 h-5') {
  const path = type === 'income'
    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 11l5-5m0 0l5 5m-5-5v12"/>'
    : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 13l-5 5m0 0l-5-5m5 5V6"/>';
  return `<div class="tx-icon ${type === 'income' ? 'bg-income/15' : 'bg-expense/15'}"><svg class="${size} ${type === 'income' ? 'text-income' : 'text-expense'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${path}</svg></div>`;
}

const RECURRING_BADGE = '<span class="recurring-badge"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>Rec</span>';

function updateDashboard() {
  updateDashboardPeriodContext();
  let visibleTx = State.dashboardPeriod === 'custom'
    ? filterByDateRange(State.transactions, State.dashboardCustomDate, 'month')
    : filterByPeriod(State.transactions, State.dashboardPeriod);

  const income = visibleTx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = visibleTx.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const balance = income - expense;
  safeSetText('dash-balance', formatMoney(balance));
  safeSetText('dash-income', formatMoney(income));
  safeSetText('dash-expense', formatMoney(expense));
  safeSetText('dash-savings', formatMoney(Math.max(0, balance)));

  const insightBaseDate = State.dashboardPeriod === 'custom' ? State.dashboardCustomDate : new Date();
  const monthFocusTransactions = getMonthTransactions(insightBaseDate);
  const health = buildMonthlyHealth(monthFocusTransactions);
  safeSetText('health-real-balance', formatMoney(health.realBalance));
  safeSetText('health-committed', formatMoney(health.committed));
  safeSetText('health-free', formatMoney(health.free));
  safeSetText('health-period-label', getMonthLabel(insightBaseDate));

  const pendingIncome = visibleTx.filter(t => t.type === 'income' && t.status === 'pending').reduce((s, t) => s + t.amount, 0);
  const pendingExpense = visibleTx.filter(t => t.type === 'expense' && t.status === 'pending').reduce((s, t) => s + t.amount, 0);
  const pendingAlerts = document.getElementById('pending-alerts');
  if (pendingAlerts) {
    if (pendingIncome > 0 || pendingExpense > 0) {
      pendingAlerts.classList.remove('hidden');
      safeSetText('dash-pending-income', formatMoney(pendingIncome));
      safeSetText('dash-pending-expense', formatMoney(pendingExpense));
    } else {
      pendingAlerts.classList.add('hidden');
    }
  }

  const insightsEl = document.getElementById('dashboard-insights');
  if (insightsEl) insightsEl.innerHTML = buildDashboardInsights(monthFocusTransactions).map(item => `<div class="insight-item">${escapeHtml(item)}</div>`).join('');

  renderCategories(visibleTx, expense);
  renderRecentTransactions(visibleTx);
}

function renderCategories(transactions, totalExpense) {
  const byCat = {};
  transactions.filter(t => t.type === 'expense').forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const emptyEl = document.getElementById('dash-categories-empty');
  const listEl = document.getElementById('dash-categories');
  if (!emptyEl || !listEl) return;
  if (!entries.length) { emptyEl.classList.remove('hidden'); listEl.classList.add('hidden'); return; }
  emptyEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = entries.map(([catId, amount]) => {
    const cat = getCategory(catId);
    const pct = totalExpense > 0 ? (amount / totalExpense * 100).toFixed(1) : 0;
    return `
      <div class="py-3 border-b border-brand/5">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full" style="background: ${cat.color}"></span>
            <span class="text-sm text-white">${escapeHtml(cat.name)}</span>
          </div>
          <div class="flex items-center gap-3 flex-shrink-0">
            <span class="text-sm font-semibold text-white">${formatMoney(amount)}</span>
            <span class="text-xs text-[#6b8a99]">${pct}%</span>
          </div>
        </div>
        <div class="h-1.5 rounded-full overflow-hidden" style="background: rgba(19, 42, 60, 0.8)">
          <div class="h-full rounded-full transition-all" style="width: ${pct}%; background: ${cat.color}"></div>
        </div>
      </div>`;
  }).join('');
}

function renderRecentTransactions(transactions) {
  const visible = sortTransactionsByDateDesc(transactions).slice(0, 5);
  const emptyEl = document.getElementById('dash-tx-empty');
  const listEl = document.getElementById('dash-tx-list');
  if (!emptyEl || !listEl) return;
  if (!visible.length) { emptyEl.classList.remove('hidden'); listEl.classList.add('hidden'); return; }
  emptyEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = visible.map(t => {
    const cat = getCategory(t.category);
    const account = getAccount(t.accountId);
    return `
      <div class="tx-item" onclick="editTransaction('${escapeJsString(t.id)}')">
        ${txIconHtml(t.type)}
        <div class="tx-content">
          <p class="tx-title">${escapeHtml(t.description)} ${t.status === 'pending' ? '<span style="color:#ff8a50;font-size:9px;margin-left:4px;">Pendente</span>' : ''}${t.recurring ? RECURRING_BADGE : ''}</p>
          <p class="tx-sub">${escapeHtml(cat.name)} - ${escapeHtml(account.name)}${authorSuffix(t)}</p>
        </div>
        <div class="tx-right">
          <p class="tx-amount ${t.type === 'income' ? 'text-income' : 'text-expense'}">${t.type === 'income' ? '+' : '-'}${formatMoney(t.amount)}</p>
        </div>
      </div>`;
  }).join('');
}

function renderControlPage() {
  const periodFiltered = sortTransactionsByDateDesc(
    State.controlPeriod === 'custom'
      ? filterByDateRange(State.transactions, State.controlCustomDate, 'month')
      : filterByPeriod(State.transactions, State.controlPeriod)
  );
  const incomes = periodFiltered.filter(t => t.type === 'income');
  const expenses = periodFiltered.filter(t => t.type === 'expense');
  const sum = (list) => list.reduce((s, t) => s + t.amount, 0);
  safeSetText('control-pending-income', formatMoney(sum(incomes)));
  safeSetText('control-pending-expense', formatMoney(sum(expenses)));
  safeSetText('control-received', formatMoney(sum(incomes.filter(t => t.status === 'paid'))));
  safeSetText('control-income-pending', formatMoney(sum(incomes.filter(t => t.status === 'pending'))));
  safeSetText('control-paid', formatMoney(sum(expenses.filter(t => t.status === 'paid'))));
  safeSetText('control-expense-pending', formatMoney(sum(expenses.filter(t => t.status === 'pending'))));
  renderControlList('income', incomes);
  renderControlList('expense', expenses);
}

function renderControlList(type, transactions) {
  const emptyEl = document.getElementById(`control-${type}-empty`);
  const listEl = document.getElementById(`control-${type}-list`);
  if (!emptyEl || !listEl) return;
  let filtered = transactions;
  if (State.controlFilter === 'pending') filtered = transactions.filter(t => t.status === 'pending');
  else if (State.controlFilter === 'paid') filtered = transactions.filter(t => t.status === 'paid');
  safeSetText(`control-${type}-count`, String(filtered.length));
  safeSetText(`control-${type}-tab-count`, String(filtered.length));
  if (!filtered.length) { emptyEl.classList.remove('hidden'); listEl.classList.add('hidden'); return; }
  emptyEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = filtered.map(t => {
    const account = getAccount(t.accountId);
    const isPending = t.status === 'pending';
    const statusText = type === 'income' ? (isPending ? 'A Receber' : 'Recebido') : (isPending ? 'A Pagar' : 'Pago');
    return `
      <div class="tx-item" onclick="editTransaction('${escapeJsString(t.id)}')">
        ${txIconHtml(type)}
        <div class="tx-content">
          <p class="tx-title">${escapeHtml(t.description)} ${t.recurring ? RECURRING_BADGE : ''}</p>
          <p class="tx-sub">${formatDate(t.date)} - ${escapeHtml(account.name)}${authorSuffix(t)}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="text-sm font-semibold ${type === 'income' ? 'text-income' : 'text-expense'}">${type === 'income' ? '+' : '-'}${formatMoney(t.amount)}</span>
          <button onclick="event.stopPropagation(); toggleTransactionStatus('${escapeJsString(t.id)}')" class="toggle-status-btn ${isPending ? 'pending' : 'paid'}">${statusText}</button>
        </div>
      </div>`;
  }).join('');
}

function updateTransactionTypeTabs(monthTransactions = []) {
  if (!['all', 'income', 'expense'].includes(currentFilter.type)) currentFilter.type = 'all';
  document.querySelectorAll('[data-tx-type-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.txTypeTab === currentFilter.type));
  safeSetText('tx-all-tab-count', String(monthTransactions.length));
  safeSetText('tx-income-tab-count', String(monthTransactions.filter(t => t.type === 'income').length));
  safeSetText('tx-expense-tab-count', String(monthTransactions.filter(t => t.type === 'expense').length));
}

function renderTransactions() {
  updateTxPeriodContext();
  let visible = filterByDateRange(State.transactions, State.txCustomDate, 'month');
  updateTransactionTypeTabs(visible);
  if (currentFilter.type !== 'all') visible = visible.filter(t => t.type === currentFilter.type);
  visible = sortTransactionsByDateDesc(visible);
  const listEl = document.getElementById('tx-list');
  const emptyEl = document.getElementById('tx-list-empty');
  if (!listEl || !emptyEl) return;
  safeSetText('tx-count-label', `${visible.length} ${visible.length === 1 ? 'transação' : 'transações'}`);
  if (!visible.length) { listEl.classList.add('hidden'); emptyEl.classList.remove('hidden'); return; }
  listEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  listEl.innerHTML = visible.map(t => {
    const cat = getCategory(t.category);
    const account = getAccount(t.accountId);
    return `
      <div class="tx-item">
        ${txIconHtml(t.type)}
        <div class="tx-content">
          <p class="tx-title">${escapeHtml(t.description)} ${t.status === 'pending' ? '<span style="color:#ff8a50;font-size:9px;margin-left:4px;">Pendente</span>' : ''}${t.recurring ? RECURRING_BADGE : ''}</p>
          <p class="tx-sub">${escapeHtml(cat.name)} - ${formatDate(t.date)} - ${escapeHtml(account.name)}${authorSuffix(t)}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="tx-amount ${t.type === 'income' ? 'text-income' : 'text-expense'}">${t.type === 'income' ? '+' : '-'}${formatMoney(t.amount)}</span>
          <button onclick="editTransaction('${escapeJsString(t.id)}')" class="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center text-brand hover:bg-brand/20 transition-colors" aria-label="Editar">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

// Metas
function normalizeGoalDeadline(value) {
  if (!value) return '';
  const match = String(value).trim().match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function parseGoalDeadline(value) {
  const normalized = normalizeGoalDeadline(value);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  const date = new Date(year, month, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getGoalDeadlineLabel(value) {
  const date = parseGoalDeadline(value);
  return date ? date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : 'Sem prazo';
}

function getGoalMonthsRemaining(value) {
  const deadline = parseGoalDeadline(value);
  if (!deadline) return null;
  const today = new Date();
  return ((deadline.getFullYear() - today.getFullYear()) * 12) + (deadline.getMonth() - today.getMonth()) + 1;
}

function getGoalProgress(goal) {
  const target = Math.max(0, Number(goal?.target) || 0);
  const current = Math.max(0, Number(goal?.current) || 0);
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  const remaining = Math.max(0, target - current);
  const monthsRemaining = getGoalMonthsRemaining(goal?.deadline);
  const monthlyRequired = monthsRemaining && monthsRemaining > 0 ? remaining / monthsRemaining : 0;
  const archived = Boolean(goal?.archived);
  let status = { label: 'Em andamento', className: '', rank: 3, detail: 'Meta sem prazo definido.' };
  if (archived) status = { label: 'Arquivada', className: 'archived', rank: 6, detail: 'Meta guardada no histórico.' };
  else if (target > 0 && current >= target) status = { label: 'Concluída', className: 'complete', rank: 5, detail: 'Objetivo alcançado.' };
  else if (monthsRemaining !== null && monthsRemaining <= 0) status = { label: 'Atrasada', className: 'overdue', rank: 0, detail: 'Prazo vencido. Reajuste o prazo ou faça um novo aporte.' };
  else if (pct >= 80) status = { label: 'Quase lá', className: 'warning', rank: 2, detail: 'Meta perto de ser concluída.' };
  else if (monthsRemaining !== null && monthsRemaining <= 1) status = { label: 'Prioridade', className: 'warning', rank: 1, detail: 'Prazo muito próximo.' };
  else if (monthsRemaining !== null) status = { label: 'No prazo', className: '', rank: 3, detail: `${monthsRemaining} ${monthsRemaining === 1 ? 'mês restante' : 'meses restantes'}.` };
  return { target, current, pct, remaining, completed: target > 0 && current >= target, archived, monthsRemaining, monthlyRequired, status };
}

function updateGoalsSummary(goals = State.goals) {
  if (!['all', 'active', 'completed', 'archived'].includes(activeGoalsTab)) activeGoalsTab = 'all';
  const summary = goals.reduce((acc, goal) => {
    const progress = getGoalProgress(goal);
    if (progress.archived) { acc.archived += 1; return acc; }
    acc.current += progress.current;
    acc.target += progress.target;
    acc.remaining += progress.remaining;
    if (!progress.completed) acc.monthlyNeeded += progress.monthlyRequired;
    if (progress.completed) acc.completed += 1;
    return acc;
  }, { current: 0, target: 0, remaining: 0, completed: 0, archived: 0, monthlyNeeded: 0 });
  const visibleGoals = goals.filter(goal => !getGoalProgress(goal).archived);
  const activeCount = visibleGoals.filter(goal => !getGoalProgress(goal).completed).length;
  safeSetText('goals-total-current', formatMoney(summary.current));
  safeSetText('goals-total-target', formatMoney(summary.target));
  safeSetText('goals-total-remaining', formatMoney(summary.remaining));
  safeSetText('goals-completed-count', `${summary.completed}/${visibleGoals.length}`);
  safeSetText('goals-monthly-needed', formatMoney(summary.monthlyNeeded));
  safeSetText('goals-archived-count', String(summary.archived));
  safeSetText('goal-all-tab-count', String(visibleGoals.length));
  safeSetText('goal-active-tab-count', String(activeCount));
  safeSetText('goal-completed-tab-count', String(summary.completed));
  safeSetText('goal-archived-tab-count', String(summary.archived));
  document.querySelectorAll('[data-goal-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.goalTab === activeGoalsTab));
}

function switchGoalsTab(tab = 'all') {
  activeGoalsTab = ['all', 'active', 'completed', 'archived'].includes(tab) ? tab : 'all';
  renderGoals();
}

function sortGoalsForDisplay(goals = []) {
  return [...goals].sort((a, b) => {
    const ap = getGoalProgress(a);
    const bp = getGoalProgress(b);
    if (ap.status.rank !== bp.status.rank) return ap.status.rank - bp.status.rank;
    const aDeadline = parseGoalDeadline(a.deadline)?.getTime() || Number.MAX_SAFE_INTEGER;
    const bDeadline = parseGoalDeadline(b.deadline)?.getTime() || Number.MAX_SAFE_INTEGER;
    if (aDeadline !== bDeadline) return aDeadline - bDeadline;
    return bp.pct - ap.pct;
  });
}

function renderGoals() {
  const emptyEl = document.getElementById('goals-empty');
  const listEl = document.getElementById('goals-list');
  if (!emptyEl || !listEl) return;
  const goals = Array.isArray(State.goals) ? State.goals : [];
  updateGoalsSummary(goals);
  const filteredGoals = sortGoalsForDisplay(goals.filter(goal => {
    const progress = getGoalProgress(goal);
    if (activeGoalsTab === 'archived') return progress.archived;
    if (activeGoalsTab === 'active') return !progress.archived && !progress.completed;
    if (activeGoalsTab === 'completed') return !progress.archived && progress.completed;
    return !progress.archived;
  }));
  if (!goals.length) {
    emptyEl.innerHTML = `<strong>Nenhuma meta cadastrada</strong><p class="text-sm">Crie uma meta para acompanhar quanto falta guardar.</p><button class="mt-4 px-6 py-2.5 bg-brand text-white font-semibold rounded-xl hover:bg-brand-light transition-colors" onclick="openModalGoal()">Criar Meta</button>`;
    emptyEl.classList.remove('hidden'); listEl.classList.add('hidden'); return;
  }
  if (!filteredGoals.length) {
    emptyEl.innerHTML = `<strong>Nenhuma meta nesta visão</strong><p class="text-sm">Altere o filtro para visualizar suas outras metas.</p><button class="mt-4 px-6 py-2.5 bg-brand/15 text-brand font-semibold rounded-xl hover:bg-brand/25 transition-colors" onclick="switchGoalsTab('all')">Ver Todas</button>`;
    emptyEl.classList.remove('hidden'); listEl.classList.add('hidden'); return;
  }
  emptyEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = filteredGoals.map(g => {
    const progress = getGoalProgress(g);
    const contributions = Array.isArray(g.contributions) ? g.contributions : [];
    const recent = contributions.slice().sort((a, b) => (parseLocalDate(b.date)?.getTime() || 0) - (parseLocalDate(a.date)?.getTime() || 0)).slice(0, 3);
    const historyHtml = recent.length
      ? `<div class="goal-history"><div class="goal-history-title">Últimos aportes</div>${recent.map(item => `<div class="goal-history-row"><span>${formatDate(item.date)}${item.by ? ` · ${escapeHtml(memberName(item.by))}` : ''}</span><span>${formatMoney(Number(item.amount) || 0)}</span></div>`).join('')}</div>`
      : '';
    const id = escapeJsString(g.id);
    const primaryAction = progress.archived
      ? `<button onclick="restoreGoal('${id}')" class="goal-add-btn">Restaurar Meta</button>`
      : progress.completed
        ? `<button onclick="archiveGoal('${id}')" class="goal-add-btn">Arquivar Meta</button>`
        : `<button onclick="openModalGoalAdd('${id}')" class="goal-add-btn">Adicionar Valor</button>`;
    const monthlyGoalText = progress.archived || progress.completed ? formatMoney(0) : progress.monthsRemaining && progress.monthsRemaining > 0 ? formatMoney(progress.monthlyRequired) : 'Sem prazo';
    const archiveOrDeleteButton = progress.archived
      ? `<button onclick="deleteGoalPermanently('${id}')" class="goal-icon-btn danger" title="Excluir definitivamente" aria-label="Excluir definitivamente"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m2 0H7m3 0V5a2 2 0 012-2h0a2 2 0 012 2v2"/></svg></button>`
      : `<button onclick="archiveGoal('${id}')" class="goal-icon-btn warn" title="Arquivar meta" aria-label="Arquivar meta"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8l4 4 4-4m-8 8h14a2 2 0 002-2V7a2 2 0 00-2-2h-4l-2-2H7a2 2 0 00-2 2v11z"/></svg></button>`;
    return `
      <div class="card goal-card">
        <div class="goal-card-head">
          <h3 class="goal-title">${escapeHtml(g.title)}</h3>
          <span class="goal-status ${progress.status.className}">${progress.status.label}</span>
        </div>
        <div class="goal-meta-row">
          <span class="goal-chip">${escapeHtml(getGoalCategoryLabel(g.category))}</span>
          <span class="goal-chip">${escapeHtml(getGoalDeadlineLabel(g.deadline))}</span>
          <span class="goal-chip">${progress.pct}% concluído</span>
        </div>
        <div class="goal-progress-track"><div class="goal-progress-bar ${progress.status.className}" style="width: ${progress.pct}%"></div></div>
        <div class="goal-money-row">
          <div class="goal-money-item"><span class="goal-money-label">Atual</span><strong class="goal-money-value">${formatMoney(progress.current)}</strong></div>
          <div class="goal-money-item"><span class="goal-money-label">Meta</span><strong class="goal-money-value text-brand">${formatMoney(progress.target)}</strong></div>
          <div class="goal-money-item"><span class="goal-money-label">Falta</span><strong class="goal-money-value text-warning">${formatMoney(progress.remaining)}</strong></div>
          <div class="goal-money-item"><span class="goal-money-label">Por mês</span><strong class="goal-money-value text-brand">${monthlyGoalText}</strong></div>
        </div>
        <p class="goal-plan-note">${escapeHtml(progress.status.detail)}${!progress.archived && !progress.completed && progress.monthsRemaining ? ` Sugestão: guardar ${formatMoney(progress.monthlyRequired)} por mês.` : ''}</p>
        ${historyHtml}
        <div class="goal-action-row">
          ${primaryAction}
          <button onclick="editGoal('${id}')" class="goal-icon-btn" title="Editar meta" aria-label="Editar meta"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>
          ${archiveOrDeleteButton}
        </div>
      </div>`;
  }).join('');
}

// Relatórios
function renderReports() {
  updateReportPeriodContext();
  const monthTx = filterByDateRange(State.transactions, State.reportCustomDate, 'month');
  const income = monthTx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = monthTx.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  safeSetText('report-total-income', formatMoney(income));
  safeSetText('report-total-expense', formatMoney(expense));
  safeSetText('report-balance', formatMoney(income - expense));

  const profitSummary = buildMonthlyProfitSummary(State.transactions);
  const selectedKey = getMonthKeyFromDate(State.reportCustomDate);
  safeSetText('report-month-profit', formatMoney(profitSummary.months.find(item => item.key === selectedKey)?.profit || 0));
  safeSetText('report-total-profit', formatMoney(profitSummary.totalProfit));
  safeSetText('report-average-profit', formatMoney(profitSummary.averageProfit));

  const profitList = document.getElementById('report-monthly-profit-list');
  if (profitList) {
    if (profitSummary.months.length) {
      const maxAbs = Math.max(...profitSummary.months.map(item => Math.abs(item.profit)), 1);
      profitList.innerHTML = profitSummary.months.slice(0, 12).map(item => `
        <div class="report-bar-container">
          <div class="report-bar-header">
            <span class="text-white font-medium">${escapeHtml(item.label)}</span>
            <span class="${item.profit >= 0 ? 'text-brand' : 'text-expense'} text-right font-semibold">${formatMoney(item.profit)}</span>
          </div>
          <div class="report-bar-bg"><div class="report-bar-fill" style="width: ${Math.max(4, Math.abs(item.profit) / maxAbs * 100)}%; background-color: ${item.profit >= 0 ? '#00b4a0' : '#ff5252'}"></div></div>
          <div class="flex justify-between text-[10px] text-[#6b8a99] mt-1"><span>Receitas: ${formatMoney(item.income)}</span><span>Despesas: ${formatMoney(item.expense)}</span></div>
        </div>`).join('');
    } else {
      profitList.innerHTML = '<p class="text-center text-sm text-[#6b8a99]">Sem meses com movimentação para calcular rendimento.</p>';
    }
  }

  const breakdown = (containerId, type, total, emptyText) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const byCat = {};
    monthTx.filter(t => t.type === type).forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { container.innerHTML = `<p class="text-center text-sm text-[#6b8a99]">${emptyText}</p>`; return; }
    container.innerHTML = entries.map(([catId, amount]) => {
      const cat = getCategory(catId);
      const pct = total > 0 ? (amount / total * 100) : 0;
      return `
        <div class="report-bar-container">
          <div class="report-bar-header">
            <span class="text-white font-medium">${escapeHtml(cat.name)}</span>
            <span class="text-[#6b8a99] text-right">${formatMoney(amount)} (${pct.toFixed(1)}%)</span>
          </div>
          <div class="report-bar-bg"><div class="report-bar-fill" style="width: ${pct}%; background-color: ${cat.color}"></div></div>
        </div>`;
    }).join('');
  };
  breakdown('report-expenses-breakdown', 'expense', expense, 'Sem dados de despesas');
  breakdown('report-income-breakdown', 'income', income, 'Sem dados de receitas');

  const budgetContainer = document.getElementById('report-budget-breakdown');
  if (budgetContainer) {
    const budgetSummary = getBudgetSummary(monthTx).filter(item => item.budget > 0);
    budgetContainer.innerHTML = budgetSummary.length
      ? budgetSummary.map(item => `
        <div class="report-bar-container">
          <div class="report-bar-header">
            <span class="text-white font-medium">${escapeHtml(item.name)}</span>
            <span class="text-[#6b8a99] text-right">${formatMoney(item.spent)} de ${formatMoney(item.budget)} (${item.percent.toFixed(0)}%)</span>
          </div>
          <div class="report-bar-bg"><div class="report-bar-fill" style="width: ${Math.min(item.percent, 100)}%; background-color: ${item.percent > 100 ? '#ff5252' : item.percent >= 80 ? '#ffb300' : '#00b4a0'}"></div></div>
        </div>`).join('')
      : '<p class="text-center text-sm text-[#6b8a99]">Defina limites de orçamento em Configurações, aba Contas.</p>';
  }
}

// Calendário
function renderCalendar() {
  const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  safeSetText('cal-month-year', `${monthNames[calDate.getMonth()]} ${calDate.getFullYear()}`);
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  const firstDay = new Date(calDate.getFullYear(), calDate.getMonth(), 1);
  const lastDay = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 0);
  const startPadding = firstDay.getDay();
  const prevMonth = new Date(calDate.getFullYear(), calDate.getMonth(), 0);
  let html = '';
  for (let i = startPadding - 1; i >= 0; i -= 1) html += `<div class="calendar-day muted">${prevMonth.getDate() - i}</div>`;
  const monthTx = filterByDateRange(State.transactions, calDate, 'month');
  const todayStr = todayInput();
  for (let d = 1; d <= lastDay.getDate(); d += 1) {
    const dateStr = `${calDate.getFullYear()}-${String(calDate.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayTx = monthTx.filter(t => t.date === dateStr);
    const dayIncome = dayTx.some(t => t.type === 'income');
    const dayExpense = dayTx.some(t => t.type === 'expense');
    let dayClass = 'calendar-day';
    if (State.calendarSelectedDate === dateStr) dayClass += ' selected';
    else if (dateStr === todayStr) dayClass += ' today';
    html += `
      <button type="button" class="${dayClass}" onclick="selectCalendarDay('${dateStr}')" aria-label="Ver lançamentos de ${String(d).padStart(2, '0')}/${String(calDate.getMonth() + 1).padStart(2, '0')}/${calDate.getFullYear()}">
        <span>${d}</span>
        ${dayTx.length ? `<div class="calendar-day-dots">${dayIncome ? '<span class="calendar-dot bg-income"></span>' : ''}${dayExpense ? '<span class="calendar-dot bg-expense"></span>' : ''}</div>` : ''}
      </button>`;
  }
  grid.innerHTML = html;
  updateCalendarSummary(monthTx);
}

function selectCalendarDay(dateStr) {
  State.calendarSelectedDate = State.calendarSelectedDate === dateStr ? null : dateStr;
  renderCalendar();
}

function clearCalendarFilter() { State.calendarSelectedDate = null; renderCalendar(); }

function calToday() {
  const today = new Date();
  calDate = new Date(today.getFullYear(), today.getMonth(), 1);
  State.calendarSelectedDate = todayInput();
  renderCalendar();
}

function calPrev() { calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1); State.calendarSelectedDate = null; renderCalendar(); }
function calNext() { calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1); State.calendarSelectedDate = null; renderCalendar(); }

function updateCalendarSummary(monthTx) {
  const listEl = document.getElementById('cal-day-list');
  const titleEl = document.getElementById('cal-detail-title');
  const clearBtn = document.getElementById('cal-clear-filter');
  if (!listEl || !titleEl || !clearBtn) return;
  let displayTx = sortTransactionsByDateAsc(monthTx);
  if (State.calendarSelectedDate) {
    displayTx = sortTransactionsByDateAsc(monthTx.filter(t => t.date === State.calendarSelectedDate));
    const dateObj = parseLocalDate(State.calendarSelectedDate);
    titleEl.textContent = `Dia ${dateObj.getDate()} de ${dateObj.toLocaleDateString('pt-BR', { month: 'long' })}`;
    clearBtn.classList.remove('hidden');
  } else {
    titleEl.textContent = 'Resumo do Mês';
    clearBtn.classList.add('hidden');
  }
  const sum = (filter) => displayTx.filter(filter).reduce((s, t) => s + t.amount, 0);
  const income = sum(t => t.type === 'income');
  const expense = sum(t => t.type === 'expense');
  safeSetText('cal-income', formatMoney(income));
  safeSetText('cal-expense', formatMoney(expense));
  safeSetText('cal-balance', formatMoney(income - expense));
  safeSetText('cal-pending', formatMoney(sum(t => t.type === 'expense' && t.status === 'pending')));

  const todayKey = todayInput();
  const monthSorted = sortTransactionsByDateAsc(monthTx);
  const nextTx = monthSorted.find(t => t.type === 'expense' && t.status === 'pending' && t.date >= todayKey)
    || monthSorted.find(t => t.status === 'pending' && t.date >= todayKey)
    || monthSorted.find(t => t.date >= todayKey)
    || monthSorted[0];
  const nextAmountEl = document.getElementById('cal-next-amount');
  if (nextTx) {
    safeSetText('cal-next-title', nextTx.description || 'Lançamento');
    safeSetText('cal-next-detail', `${formatDate(nextTx.date)} - ${getCategory(nextTx.category).name} - ${getAccount(nextTx.accountId).name}`);
    if (nextAmountEl) { nextAmountEl.textContent = `${nextTx.type === 'income' ? '+' : '-'}${formatMoney(nextTx.amount)}`; nextAmountEl.className = `calendar-next-amount ${nextTx.type === 'income' ? 'text-income' : 'text-expense'}`; }
  } else {
    safeSetText('cal-next-title', 'Sem lançamentos');
    safeSetText('cal-next-detail', 'Nenhuma movimentação neste mês.');
    if (nextAmountEl) { nextAmountEl.textContent = formatMoney(0); nextAmountEl.className = 'calendar-next-amount'; }
  }

  if (displayTx.length) {
    listEl.innerHTML = displayTx.map(t => {
      const isPending = t.status === 'pending';
      const statusText = t.type === 'income' ? (isPending ? 'A receber' : 'Recebido') : (isPending ? 'A pagar' : 'Pago');
      return `
        <div class="tx-item" onclick="editTransaction('${escapeJsString(t.id)}')">
          ${txIconHtml(t.type, 'w-4 h-4')}
          <div class="tx-content">
            <p class="tx-title text-xs">${escapeHtml(t.description)}</p>
            <p class="tx-sub text-[10px]">${formatDate(t.date)} - ${escapeHtml(getCategory(t.category).name)} - ${escapeHtml(getAccount(t.accountId).name)} - ${statusText}${authorSuffix(t)}</p>
          </div>
          <span class="text-xs font-semibold ${t.type === 'income' ? 'text-income' : 'text-expense'}">${t.type === 'income' ? '+' : '-'}${formatMoney(t.amount)}</span>
        </div>`;
    }).join('');
  } else {
    listEl.innerHTML = `<p class="text-center text-xs text-[#6b8a99] py-4">${State.calendarSelectedDate ? 'Sem transações neste dia.' : 'Sem lançamentos neste mês.'}</p>`;
  }
}

// Configurações
function renderSettingsAccounts() {
  const container = document.getElementById('settings-accounts-list');
  if (!container) return;
  const balances = calculateAccountBalances(State.transactions);
  container.innerHTML = balances.map(account => `
    <div class="account-summary-item cursor-pointer" onclick="openModalAccount('${escapeJsString(account.id)}')">
      <div class="account-summary-name">
        <span class="account-dot" style="background:${escapeHtml(account.color)}"></span>
        <div class="min-w-0">
          <div class="account-summary-title">${escapeHtml(account.name)}</div>
          <div class="account-summary-type">${escapeHtml(account.type)}</div>
        </div>
      </div>
      <div class="account-summary-balance">${formatMoney(account.balance)}</div>
    </div>`).join('');
}

function renderBudgetSettings() {
  const container = document.getElementById('settings-budgets-list');
  if (!container) return;
  if (document.activeElement && container.contains(document.activeElement)) return; // não atrapalha quem está digitando
  const summary = getBudgetSummary(getMonthTransactions(new Date()));
  container.innerHTML = summary.map(item => `
    <div class="budget-row">
      <div class="budget-meta">
        <div class="budget-name">${escapeHtml(item.name)}</div>
        <div class="budget-sub">Gasto no mês: ${formatMoney(item.spent)}${item.budget > 0 ? ` de ${formatMoney(item.budget)}` : ''}</div>
      </div>
      <input type="text" inputmode="numeric" class="input-styled budget-input" value="${item.budget ? item.budget.toFixed(2).replace('.', ',') : ''}" placeholder="0,00" oninput="formatCurrency(this)" onchange="updateBudget('${item.id}', this.value)">
    </div>`).join('');
}

function renderMembers() {
  const container = document.getElementById('casa-members');
  if (!container) return;
  if (!State.members.length) { container.innerHTML = '<div class="admin-empty">Ainda não carregou quem está na casa.</div>'; return; }
  container.innerHTML = State.members.map(m => `
    <div class="member-item">
      <div class="member-avatar" style="background:${escapeHtml(m.cor)}">${m.foto ? `<img src="${m.foto}" alt="">` : escapeHtml(initialsOf(m.nome))}</div>
      <div class="min-w-0">
        <div class="member-name">${escapeHtml(m.nome)}${m.userId === me?.id ? ' <span class="member-you">você</span>' : ''}</div>
        <div class="member-meta">${m.userId === me?.id ? escapeHtml(me?.email || '') : 'Compartilha esta casa'}</div>
      </div>
    </div>`).join('');
}

function renderColorSwatches(containerId, selected, onPickName) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = MEMBER_COLORS.map(color => `<button type="button" class="swatch${color === selected ? ' active' : ''}" style="background:${color}" onclick="${onPickName}('${color}')" aria-label="Cor ${color}"></button>`).join('');
}

function selectProfileColor(color) {
  State.profile.color = color;
  renderColorSwatches('settings-color-swatches', color, 'selectProfileColor');
  updateAllAvatars();
}

function selectAccountColor(color) {
  const input = document.getElementById('account-color');
  if (input) input.value = color;
  renderColorSwatches('account-color-swatches', color, 'selectAccountColor');
}

function loadProfileToSettings() {
  const nameInput = document.getElementById('settings-name');
  const emailInput = document.getElementById('settings-email');
  if (nameInput) nameInput.value = State.profile.name || '';
  if (emailInput) emailInput.value = me?.email || State.profile.email || '';
  renderColorSwatches('settings-color-swatches', State.profile.color, 'selectProfileColor');
  updateProfilePhoto();
  renderSettingsAccounts();
  renderBudgetSettings();
  renderMembers();
  renderDataHealthPanel();
  renderNotifSettings();
  updateLegacyCard();
  safeSetText('app-version', APP_VERSION);
  switchSettingsTab(activeSettingsTab, { scroll: false });
}

function switchSettingsTab(tab = 'profile', { scroll = true } = {}) {
  activeSettingsTab = tab;
  document.querySelectorAll('[data-settings-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.settingsTab === tab));
  document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.settingsPanel !== tab));
  if (scroll && !document.getElementById('page-settings')?.classList.contains('hidden')) document.querySelector('#page-settings .settings-tabs')?.scrollIntoView({ block: 'nearest' });
}

function switchReportTab(tab = 'summary', { scroll = true } = {}) {
  activeReportTab = tab;
  document.querySelectorAll('[data-report-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.reportTab === tab));
  document.querySelectorAll('[data-report-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.reportPanel !== tab));
  if (scroll && !document.getElementById('page-reports')?.classList.contains('hidden')) document.querySelector('#page-reports .section-tabs')?.scrollIntoView({ block: 'nearest' });
}

function switchControlTab(tab = 'income', { scroll = true } = {}) {
  activeControlTab = tab;
  document.querySelectorAll('[data-control-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.controlTab === tab));
  document.querySelectorAll('[data-control-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.controlPanel !== tab));
  if (scroll && !document.getElementById('page-control')?.classList.contains('hidden')) document.querySelector('#page-control .section-tabs')?.scrollIntoView({ block: 'nearest' });
}

function switchDashboardTab(tab = 'overview', { scroll = true } = {}) {
  activeDashboardTab = tab;
  document.querySelectorAll('[data-dashboard-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.dashboardTab === tab));
  document.querySelectorAll('[data-dashboard-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.dashboardPanel !== tab));
  if (scroll && !document.getElementById('page-dashboard')?.classList.contains('hidden')) document.querySelector('#page-dashboard .section-tabs')?.scrollIntoView({ block: 'nearest' });
}

function updateProfilePhoto() {
  const photoEl = document.getElementById('profile-photo');
  if (!photoEl) return;
  photoEl.innerHTML = State.profile.photo ? `<img src="${State.profile.photo}" alt="Perfil">` : `<span id="profile-photo-initials">${escapeHtml(initialsOf(State.profile.name || me?.email || ''))}</span>`;
  photoEl.style.background = State.profile.photo ? '' : `linear-gradient(135deg, ${State.profile.color} 0%, #008577 100%)`;
  updateAllAvatars();
}

function updateAllAvatars() {
  const name = State.profile.name || me?.email?.split('@')[0] || 'Entrar';
  const initials = initialsOf(name);
  const inner = State.profile.photo ? `<img src="${State.profile.photo}" alt="Perfil">` : `<span>${escapeHtml(initials)}</span>`;
  const sidebarAvatar = document.getElementById('sidebar-avatar');
  if (sidebarAvatar) { sidebarAvatar.innerHTML = State.profile.photo ? inner : `<span id="sidebar-avatar-text">${escapeHtml(initials)}</span>`; sidebarAvatar.style.background = State.profile.photo ? '' : `linear-gradient(135deg, ${State.profile.color} 0%, #008577 100%)`; }
  safeSetText('sidebar-profile-name', name);
  safeSetText('sidebar-profile-type', me?.email || 'Conta da casa');
  ['dashboard', 'control', 'transactions', 'calendar', 'goals', 'reports', 'settings'].forEach(h => {
    const el = document.getElementById(`header-avatar-${h}`);
    if (el) { el.innerHTML = inner; el.style.background = State.profile.photo ? '' : `linear-gradient(135deg, ${State.profile.color} 0%, #008577 100%)`; }
  });
}

function updateProfilePreview() {
  State.profile.name = document.getElementById('settings-name')?.value || '';
  updateAllAvatars();
}

function resizeImageToDataUrl(file, maxSize = 192) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não consegui ler a imagem.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Imagem inválida.'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function handleProfilePhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    State.profile.photo = await resizeImageToDataUrl(file);
    updateProfilePhoto();
    await saveProfile();
  } catch (error) {
    showToast(error?.message || 'Não consegui usar essa foto.', 'error');
  } finally {
    event.target.value = '';
  }
}

async function saveProfile() {
  State.profile.name = (document.getElementById('settings-name')?.value || State.profile.name || '').trim() || (me?.email?.split('@')[0] || 'Pessoa');
  updateAllAvatars();
  const mine = State.members.find(m => m.userId === me?.id);
  if (mine) { mine.nome = State.profile.name; mine.cor = State.profile.color; mine.foto = State.profile.photo; }
  renderMembers();
  if (!me) return;
  enqueue({ table: 'membros', kind: 'update', match: { user_id: me.id }, patch: { nome: State.profile.name, cor: State.profile.color, foto: State.profile.photo } });
  showToast('Perfil salvo!');
}

// ---------------------------------------------------------------------
// Navegação, seletores de mês e menus
// ---------------------------------------------------------------------
function toggleSidebar(forceState) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar || !overlay) return;
  const shouldOpen = typeof forceState === 'boolean' ? forceState : !sidebar.classList.contains('active');
  sidebar.classList.toggle('active', shouldOpen);
  overlay.classList.toggle('active', shouldOpen);
  syncBodyLock();
}

function openPage(page) {
  if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) document.activeElement.blur();
  if (!document.getElementById(`page-${page}`)) page = 'dashboard';
  document.querySelectorAll('section[id^="page-"]').forEach(s => s.classList.add('hidden'));
  document.getElementById(`page-${page}`)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
  if (page === 'calendar') renderCalendar();
  if (page === 'transactions') { renderTransactions(); initTxDatePicker(); }
  if (page === 'goals') renderGoals();
  if (page === 'reports') { renderReports(); initReportDatePicker(); switchReportTab(activeReportTab, { scroll: false }); }
  if (page === 'settings') loadProfileToSettings();
  if (page === 'control') { renderControlPage(); initControlDatePicker(); switchControlTab(activeControlTab, { scroll: false }); }
  if (page === 'dashboard') { updateDashboard(); switchDashboardTab(activeDashboardTab, { scroll: false }); }
  updateAllAvatars();
  closeAllDropdowns();
  toggleSidebar(false);
  window.scrollTo({ top: 0 });
}

function setMonthInput(id, date) {
  const input = document.getElementById(id);
  if (input) input.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function setDashboardCurrentMonth() {
  const now = new Date();
  State.dashboardPeriod = 'month';
  State.dashboardCustomDate = new Date(now.getFullYear(), now.getMonth(), 1);
  closeDashboardMonthPicker();
  setMonthInput('dashboard-date-input', now);
  closeAllDropdowns();
  updateDashboard();
}

function closeDashboardMonthPicker() { document.getElementById('dashboard-month-picker')?.classList.add('hidden'); }

function openDashboardMonthPicker() {
  const picker = document.getElementById('dashboard-month-picker');
  if (!picker) return;
  if (picker.classList.contains('hidden')) {
    picker.classList.remove('hidden');
    setMonthInput('dashboard-date-input', State.dashboardCustomDate);
    State.dashboardPeriod = 'custom';
  } else {
    picker.classList.add('hidden');
  }
  closeAllDropdowns();
  updateDashboard();
}

function updateDashboardFromInput(val) {
  if (!val) return;
  const [y, m] = val.split('-');
  State.dashboardCustomDate = new Date(Number(y), Number(m) - 1, 1);
  State.dashboardPeriod = 'custom';
  closeDashboardMonthPicker();
  updateDashboard();
}

function changeDashboardMonth(delta) {
  State.dashboardCustomDate.setMonth(State.dashboardCustomDate.getMonth() + delta);
  setMonthInput('dashboard-date-input', State.dashboardCustomDate);
  State.dashboardPeriod = 'custom';
  updateDashboard();
}

function getDashboardPeriodContext() {
  const now = new Date();
  if (State.dashboardPeriod === 'custom') return { title: getMonthLabel(State.dashboardCustomDate), detail: 'Mês específico selecionado para o painel.' };
  if (State.dashboardPeriod === 'week') return { title: 'Esta semana', detail: `Referência: ${getMonthLabel(now)}.` };
  if (State.dashboardPeriod === 'year') return { title: String(now.getFullYear()), detail: 'Todos os lançamentos do ano atual.' };
  if (State.dashboardPeriod === 'all') return { title: 'Todo período', detail: 'Todos os lançamentos cadastrados.' };
  return { title: getMonthLabel(now), detail: 'Mês atual do calendário.' };
}

function updateDashboardPeriodContext() {
  const context = getDashboardPeriodContext();
  safeSetText('dashboard-context-period', context.title);
  safeSetText('dashboard-context-detail', context.detail);
  safeSetText('pending-period-label', context.detail);
}

function initTxDatePicker() { setMonthInput('tx-date-input', State.txCustomDate); updateTxPeriodContext(); }
function updateTxPeriodContext() { safeSetText('tx-context-period', getMonthLabel(State.txCustomDate)); safeSetText('tx-context-detail', 'Lançamentos do período selecionado.'); }
function closeTxMonthPicker() { document.getElementById('tx-month-picker')?.classList.add('hidden'); }
function toggleTxMonthPicker() { setMonthInput('tx-date-input', State.txCustomDate); document.getElementById('tx-month-picker')?.classList.toggle('hidden'); closeAllDropdowns(); }
function setTxCurrentMonth() { const now = new Date(); State.txCustomDate = new Date(now.getFullYear(), now.getMonth(), 1); setMonthInput('tx-date-input', now); closeTxMonthPicker(); renderTransactions(); }
function updateTxFromInput(val) { if (!val) return; const [y, m] = val.split('-'); State.txCustomDate = new Date(Number(y), Number(m) - 1, 1); closeTxMonthPicker(); renderTransactions(); }
function changeTxMonth(delta) { State.txCustomDate.setMonth(State.txCustomDate.getMonth() + delta); setMonthInput('tx-date-input', State.txCustomDate); renderTransactions(); }

function initControlDatePicker() {
  setMonthInput('control-date-input', State.controlCustomDate);
  if (State.controlPeriod === 'custom') safeSetText('control-period-label', getMonthLabel(State.controlCustomDate));
}
function updateControlFromInput(val) { if (!val) return; const [y, m] = val.split('-'); State.controlCustomDate = new Date(Number(y), Number(m) - 1, 1); State.controlPeriod = 'custom'; safeSetText('control-period-label', getMonthLabel(State.controlCustomDate)); closeControlMonthPicker(); renderControlPage(); }
function changeControlMonth(delta) { State.controlCustomDate.setMonth(State.controlCustomDate.getMonth() + delta); setMonthInput('control-date-input', State.controlCustomDate); State.controlPeriod = 'custom'; safeSetText('control-period-label', getMonthLabel(State.controlCustomDate)); renderControlPage(); }
function closeControlMonthPicker() { document.getElementById('control-month-picker')?.classList.add('hidden'); }
function openControlMonthPicker() { initControlDatePicker(); document.getElementById('control-month-picker')?.classList.remove('hidden'); }

function initReportDatePicker() { setMonthInput('report-date-input', State.reportCustomDate); updateReportPeriodContext(); }
function updateReportPeriodContext() { safeSetText('report-context-period', getMonthLabel(State.reportCustomDate)); safeSetText('report-context-detail', 'Indicadores do período selecionado.'); }
function closeReportMonthPicker() { document.getElementById('report-month-picker')?.classList.add('hidden'); }
function toggleReportMonthPicker() { setMonthInput('report-date-input', State.reportCustomDate); document.getElementById('report-month-picker')?.classList.toggle('hidden'); closeAllDropdowns(); }
function setReportCurrentMonth() { const now = new Date(); State.reportCustomDate = new Date(now.getFullYear(), now.getMonth(), 1); setMonthInput('report-date-input', now); closeReportMonthPicker(); renderReports(); }
function updateReportFromInput(val) { if (!val) return; const [y, m] = val.split('-'); State.reportCustomDate = new Date(Number(y), Number(m) - 1, 1); closeReportMonthPicker(); renderReports(); }
function changeReportMonth(delta) { State.reportCustomDate.setMonth(State.reportCustomDate.getMonth() + delta); setMonthInput('report-date-input', State.reportCustomDate); renderReports(); }

function toggleDropdown(id) {
  const dropdown = document.getElementById(`dropdown-${id}`);
  document.querySelectorAll('[id^="dropdown-"]').forEach(d => { if (d.id !== `dropdown-${id}`) d.classList.add('hidden'); });
  dropdown?.classList.toggle('hidden');
}

function setControlPeriod(value, label) {
  State.controlPeriod = value;
  safeSetText('control-period-label', label);
  closeAllDropdowns();
  if (value === 'custom') openControlMonthPicker(); else closeControlMonthPicker();
  renderControlPage();
}

function setFilter(type, value) {
  currentFilter[type] = value;
  closeAllDropdowns();
  renderTransactions();
}

function filterControl(filter) {
  State.controlFilter = filter;
  document.querySelectorAll('.control-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
  renderControlPage();
}

// ---------------------------------------------------------------------
// Lançamentos
// ---------------------------------------------------------------------
function openModalTx() {
  const modal = document.getElementById('modal-tx');
  if (!modal) return;
  document.getElementById('form-tx')?.reset();
  document.getElementById('tx-id').value = '';
  document.getElementById('tx-date').value = todayInput();
  safeSetText('modal-tx-title', 'Nova Transação');
  editingTxId = null;
  setTxType('expense');
  setTxStatus('pending');
  State.selectedPaymentMethod = 'credit';
  State.selectedAccountId = State.accounts[0]?.id || 'checking';
  populateAccountOptions();
  State.isRecurring = false;
  updatePaymentMethodUI();
  updateRecurringUI();
  document.getElementById('delete-tx-btn')?.classList.add('hidden');
  modal.classList.add('active');
  syncBodyLock();
  setTimeout(() => document.getElementById('tx-amount')?.focus(), 120);
}

function closeModalTx() { document.getElementById('modal-tx')?.classList.remove('active'); syncBodyLock(); }

function setTxType(type) {
  currentTxType = type;
  document.getElementById('btn-expense')?.classList.toggle('active', type === 'expense');
  document.getElementById('btn-income')?.classList.toggle('active', type === 'income');
  const select = document.getElementById('tx-category');
  if (select) select.innerHTML = '<option value="">Selecione...</option>' + State.categories[type].map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  setTxStatus(currentTxStatus);
}

function setTxStatus(status) {
  currentTxStatus = status;
  safeSetText('status-pending-label', currentTxType === 'expense' ? 'A Pagar' : 'A Receber');
  safeSetText('status-paid-label', currentTxType === 'expense' ? 'Pago' : 'Recebido');
  document.getElementById('btn-status-pending')?.classList.toggle('active', status === 'pending');
  document.getElementById('btn-status-paid')?.classList.toggle('active', status === 'paid');
}

function selectPaymentMethod(method) { State.selectedPaymentMethod = method; updatePaymentMethodUI(); }

function populateAccountOptions() {
  const select = document.getElementById('tx-account');
  if (!select) return;
  select.innerHTML = State.accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} - ${escapeHtml(account.type)}</option>`).join('');
  select.value = State.selectedAccountId || State.accounts[0]?.id || '';
}

function updatePaymentMethodUI() {
  document.querySelectorAll('.payment-method').forEach(el => el.classList.toggle('active', el.dataset.method === State.selectedPaymentMethod));
}

function toggleRecurring() { State.isRecurring = !State.isRecurring; updateRecurringUI(); }
function updateRecurringUI() { document.getElementById('recurring-toggle')?.classList.toggle('active', State.isRecurring); }

function upsertLocalTransactions(list) {
  const byId = new Map(State.transactions.map(t => [t.id, t]));
  list.forEach(t => byId.set(t.id, { ...t, updatedBy: me?.id || null }));
  State.transactions = sortTransactionsByDateDesc([...byId.values()]);
}

function saveTransaction(e) {
  e?.preventDefault?.();
  const amount = parseMoney(document.getElementById('tx-amount').value);
  const description = document.getElementById('tx-desc').value.trim();
  const category = document.getElementById('tx-category').value;
  if (amount <= 0) { showToast('Informe um valor maior que zero.', 'error'); return; }
  if (!description) { showToast('Informe a descrição.', 'error'); return; }
  if (!category) { showToast('Escolha a categoria.', 'error'); return; }
  const existingTx = editingTxId ? State.transactions.find(t => t.id === editingTxId) : null;
  const tx = {
    id: editingTxId || newId(),
    type: currentTxType,
    amount: round2(amount),
    description,
    date: document.getElementById('tx-date').value || todayInput(),
    category,
    accountId: document.getElementById('tx-account').value || State.accounts[0]?.id || 'checking',
    paymentMethod: State.selectedPaymentMethod,
    status: currentTxStatus,
    recurring: State.isRecurring,
    recurringId: State.isRecurring ? (existingTx?.recurringId || `${editingTxId || Date.now()}_r`) : null,
    isRecurringInstance: false
  };

  let rows;
  if (State.isRecurring && !existingTx?.recurring) {
    rows = buildRecurringSeries(tx);
    if (existingTx) State.transactions = State.transactions.filter(t => t.id !== editingTxId);
    showToast(`Recorrência criada: ${rows.length} lançamentos mensais.`);
  } else {
    rows = [tx];
    showToast(editingTxId ? 'Transação atualizada!' : 'Transação salva!');
  }
  upsertLocalTransactions(rows);
  enqueue({ table: 'lancamentos', kind: 'upsert', rows: rows.map(txToRow) });
  closeModalTx();
  renderAll();
}

function editTransaction(id) {
  const tx = State.transactions.find(t => t.id === id);
  if (!tx) return;
  editingTxId = id;
  document.getElementById('tx-id').value = id;
  document.getElementById('tx-amount').value = tx.amount.toFixed(2).replace('.', ',');
  document.getElementById('tx-desc').value = tx.description;
  document.getElementById('tx-date').value = tx.date;
  safeSetText('modal-tx-title', 'Editar Transação');
  setTxType(tx.type);
  document.getElementById('tx-category').value = tx.category;
  State.selectedAccountId = tx.accountId || State.accounts[0]?.id || 'checking';
  populateAccountOptions();
  State.selectedPaymentMethod = tx.paymentMethod || 'credit';
  updatePaymentMethodUI();
  setTxStatus(tx.status || 'paid');
  State.isRecurring = tx.recurring || false;
  updateRecurringUI();
  document.getElementById('delete-tx-btn')?.classList.remove('hidden');
  document.getElementById('modal-tx')?.classList.add('active');
  syncBodyLock();
}

function showDeleteOptions() {
  const tx = State.transactions.find(t => t.id === editingTxId);
  if (tx && tx.recurring && tx.recurringId) {
    document.getElementById('modal-delete-recurring')?.classList.add('active');
    syncBodyLock();
  } else {
    deleteTransaction('single');
  }
}

function deleteTransaction(mode) {
  if (!editingTxId) return;
  const tx = State.transactions.find(t => t.id === editingTxId);
  if (!tx) return;
  if (mode === 'all' && tx.recurringId) {
    State.transactions = State.transactions.filter(t => t.recurringId !== tx.recurringId);
    enqueue({ table: 'lancamentos', kind: 'deleteWhere', column: 'recurring_id', value: tx.recurringId });
    showToast('Recorrência excluída.', 'error');
  } else {
    State.transactions = State.transactions.filter(t => t.id !== editingTxId);
    enqueue({ table: 'lancamentos', kind: 'delete', ids: [editingTxId] });
    showToast('Transação excluída.', 'error');
  }
  closeDeleteModal();
  closeModalTx();
  renderAll();
}

function closeDeleteModal() { document.getElementById('modal-delete-recurring')?.classList.remove('active'); syncBodyLock(); }

function toggleTransactionStatus(id) {
  const tx = State.transactions.find(t => t.id === id);
  if (!tx) return;
  const updated = { ...tx, status: tx.status === 'paid' ? 'pending' : 'paid' };
  upsertLocalTransactions([updated]);
  enqueue({ table: 'lancamentos', kind: 'upsert', rows: [txToRow(updated)] });
  renderAll();
  showToast(updated.status === 'paid' ? (tx.type === 'income' ? 'Marcado como recebido.' : 'Marcado como pago.') : 'Voltou para pendente.');
}

// ---------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------
function openModalGoal() {
  document.getElementById('modal-goal')?.classList.add('active');
  safeSetText('modal-goal-title', 'Nova Meta');
  ['goal-id', 'goal-title', 'goal-deadline', 'goal-target', 'goal-current'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('goal-category').value = 'reserve';
  editingGoalId = null;
  syncBodyLock();
}

function editGoal(id) {
  const goal = State.goals.find(g => g.id === id);
  if (!goal) return;
  editingGoalId = id;
  safeSetText('modal-goal-title', 'Editar Meta');
  document.getElementById('goal-id').value = id;
  document.getElementById('goal-title').value = goal.title || '';
  document.getElementById('goal-category').value = goal.category || 'other';
  document.getElementById('goal-deadline').value = normalizeGoalDeadline(goal.deadline);
  document.getElementById('goal-target').value = Number(goal.target || 0).toFixed(2).replace('.', ',');
  document.getElementById('goal-current').value = Number(goal.current || 0).toFixed(2).replace('.', ',');
  document.getElementById('modal-goal')?.classList.add('active');
  syncBodyLock();
}

function closeModalGoal() { document.getElementById('modal-goal')?.classList.remove('active'); syncBodyLock(); }

function openModalGoalAdd(id) {
  const goal = State.goals.find(g => g.id === id);
  if (!goal) return;
  editingGoalId = id;
  document.getElementById('goal-add-id').value = id;
  safeSetText('goal-add-name', goal.title);
  safeSetText('goal-add-current', formatMoney(goal.current));
  safeSetText('goal-add-target', formatMoney(goal.target));
  document.getElementById('goal-add-amount').value = '';
  document.getElementById('goal-add-date').value = todayInput();
  document.getElementById('modal-goal-add')?.classList.add('active');
  syncBodyLock();
}

function closeModalGoalAdd() { document.getElementById('modal-goal-add')?.classList.remove('active'); syncBodyLock(); }

function persistGoal(goal) {
  const idx = State.goals.findIndex(g => g.id === goal.id);
  if (idx > -1) State.goals[idx] = goal; else State.goals.push(goal);
  enqueue({ table: 'metas', kind: 'upsert', rows: [goalToRow(goal)] });
  renderGoals();
  renderAll();
}

function saveGoal(e) {
  e?.preventDefault?.();
  const title = document.getElementById('goal-title').value.trim();
  const target = parseMoney(document.getElementById('goal-target').value);
  const current = parseMoney(document.getElementById('goal-current').value) || 0;
  const existingGoal = editingGoalId ? State.goals.find(g => g.id === editingGoalId) : null;
  if (!title) { showToast('Informe o nome da meta.', 'error'); return; }
  if (target <= 0) { showToast('Informe um valor de meta válido.', 'error'); return; }
  const goal = {
    id: editingGoalId || newId(),
    title,
    category: document.getElementById('goal-category').value || 'other',
    deadline: normalizeGoalDeadline(document.getElementById('goal-deadline').value),
    target: round2(target),
    current: round2(Math.min(current, target)),
    archived: Boolean(existingGoal?.archived),
    createdAt: existingGoal?.createdAt || new Date().toISOString(),
    contributions: Array.isArray(existingGoal?.contributions) ? existingGoal.contributions : []
  };
  closeModalGoal();
  persistGoal(goal);
  showToast('Meta salva!');
}

function addToGoal(e) {
  e?.preventDefault?.();
  const id = document.getElementById('goal-add-id').value;
  const amount = parseMoney(document.getElementById('goal-add-amount').value);
  const date = document.getElementById('goal-add-date').value || todayInput();
  const goal = State.goals.find(g => g.id === id);
  if (!goal) { showToast('Meta não encontrada.', 'error'); return; }
  if (amount <= 0) { showToast('Informe um valor válido.', 'error'); return; }
  const progress = getGoalProgress(goal);
  const applied = round2(Math.min(amount, progress.remaining));
  if (applied <= 0) { showToast('Essa meta já está concluída.', 'error'); return; }
  const updated = {
    ...goal,
    current: round2(Math.min((Number(goal.current) || 0) + applied, Number(goal.target) || 0)),
    contributions: [{ id: newId(), amount: applied, date, by: me?.id || null }, ...(Array.isArray(goal.contributions) ? goal.contributions : [])]
  };
  closeModalGoalAdd();
  persistGoal(updated);
  showToast('Valor adicionado à meta!');
}

function archiveGoal(id) { const goal = State.goals.find(g => g.id === id); if (!goal) return; persistGoal({ ...goal, archived: true }); showToast('Meta arquivada.'); }
function restoreGoal(id) { const goal = State.goals.find(g => g.id === id); if (!goal) return; persistGoal({ ...goal, archived: false }); showToast('Meta restaurada.'); }

async function deleteGoalPermanently(id) {
  const goal = State.goals.find(g => g.id === id);
  if (!goal) return;
  const ok = await askConfirm({ title: 'Excluir meta?', message: `A meta "${goal.title}" será excluída para sempre.`, okLabel: 'Excluir', danger: true });
  if (!ok) return;
  State.goals = State.goals.filter(g => g.id !== id);
  enqueue({ table: 'metas', kind: 'delete', ids: [id] });
  renderGoals();
  showToast('Meta excluída.', 'error');
}

// ---------------------------------------------------------------------
// Contas, carteiras e orçamento
// ---------------------------------------------------------------------
function openModalAccount(id = '') {
  const account = id ? State.accounts.find(a => a.id === id) : null;
  editingAccountId = account ? account.id : null;
  safeSetText('modal-account-title', account ? 'Editar conta' : 'Nova conta');
  document.getElementById('account-id').value = account?.id || '';
  document.getElementById('account-name').value = account?.name || '';
  document.getElementById('account-type').value = account?.type || 'Conta corrente';
  const color = account?.color || MEMBER_COLORS[State.accounts.length % MEMBER_COLORS.length];
  document.getElementById('account-color').value = color;
  renderColorSwatches('account-color-swatches', color, 'selectAccountColor');
  document.getElementById('delete-account-btn')?.classList.toggle('hidden', !account);
  document.getElementById('modal-account')?.classList.add('active');
  syncBodyLock();
}

function closeModalAccount() { document.getElementById('modal-account')?.classList.remove('active'); syncBodyLock(); }

function saveAccount(e) {
  e?.preventDefault?.();
  const name = document.getElementById('account-name').value.trim();
  if (!name) { showToast('Informe o nome da conta.', 'error'); return; }
  const existing = editingAccountId ? State.accounts.find(a => a.id === editingAccountId) : null;
  const account = {
    id: existing?.id || newId(),
    name,
    type: document.getElementById('account-type').value || 'Conta',
    color: document.getElementById('account-color').value || '#00b4a0',
    position: existing?.position ?? State.accounts.length
  };
  const idx = State.accounts.findIndex(a => a.id === account.id);
  if (idx > -1) State.accounts[idx] = account; else State.accounts.push(account);
  State.selectedAccountId = account.id;
  enqueue({ table: 'contas', kind: 'upsert', rows: [accountToRow(account)] });
  closeModalAccount();
  populateAccountOptions();
  renderAll();
  showToast(existing ? 'Conta atualizada!' : 'Conta adicionada!');
}

async function deleteAccount() {
  if (!editingAccountId) return;
  const account = State.accounts.find(a => a.id === editingAccountId);
  if (!account) return;
  const inUse = State.transactions.filter(t => t.accountId === account.id).length;
  if (inUse) { showToast(`Esta conta tem ${inUse} lançamento(s). Mova ou exclua antes.`, 'error', 5000); return; }
  if (State.accounts.length <= 1) { showToast('Mantenha ao menos uma conta.', 'error'); return; }
  const ok = await askConfirm({ title: 'Excluir conta?', message: `A conta "${account.name}" será removida.`, okLabel: 'Excluir', danger: true });
  if (!ok) return;
  State.accounts = State.accounts.filter(a => a.id !== account.id);
  enqueue({ table: 'contas', kind: 'delete', ids: [account.id] });
  closeModalAccount();
  populateAccountOptions();
  renderAll();
  showToast('Conta excluída.', 'error');
}

function updateBudget(categoryId, value) {
  const amount = round2(parseMoney(value));
  State.budgets[categoryId] = amount;
  enqueue({ table: 'orcamentos', kind: 'upsert', rows: [{ casa_id: casaId, category: categoryId, amount }], onConflict: 'casa_id,category' });
  renderAll();
}

// ---------------------------------------------------------------------
// Senha
// ---------------------------------------------------------------------
function openPasswordChangeModal() {
  const modal = document.getElementById('modal-password-change');
  if (!modal) return;
  document.getElementById('force-new-password').value = '';
  document.getElementById('force-confirm-password').value = '';
  safeSetText('force-password-status', '');
  modal.classList.add('active');
  syncBodyLock();
  setTimeout(() => document.getElementById('force-new-password')?.focus(), 120);
}

function closePasswordChangeModal() { document.getElementById('modal-password-change')?.classList.remove('active'); syncBodyLock(); }

async function changeCurrentPassword(event = null, source = 'settings') {
  event?.preventDefault?.();
  if (isChangingPassword) return;
  const forced = source === 'forced';
  const newPassword = document.getElementById(forced ? 'force-new-password' : 'settings-new-password')?.value || '';
  const confirmPassword = document.getElementById(forced ? 'force-confirm-password' : 'settings-confirm-password')?.value || '';
  const statusId = forced ? 'force-password-status' : null;
  const submitBtn = document.getElementById(forced ? 'force-password-submit' : 'settings-password-submit');
  const originalLabel = submitBtn?.textContent || 'Atualizar senha';
  if (newPassword.length < 6) { if (statusId) safeSetText(statusId, 'Use pelo menos 6 caracteres.'); showToast('Use pelo menos 6 caracteres.', 'error'); return; }
  if (newPassword !== confirmPassword) { if (statusId) safeSetText(statusId, 'A confirmação não confere.'); showToast('A confirmação da senha não confere.', 'error'); return; }
  const c = ensureClient();
  if (!c) { showToast('Banco indisponível.', 'error'); return; }
  try {
    isChangingPassword = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Atualizando...'; }
    if (statusId) safeSetText(statusId, 'Atualizando senha...');
    const { error } = await withTimeout(c.auth.updateUser({ password: newPassword }), 20000, 'Tempo esgotado ao atualizar a senha.');
    if (error) throw error;
    ['settings-new-password', 'settings-confirm-password', 'force-new-password', 'force-confirm-password'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    if (statusId) safeSetText(statusId, 'Senha atualizada.');
    showToast('Senha atualizada com sucesso.');
    closePasswordChangeModal();
    if (forced && location.hash) history.replaceState(null, '', location.pathname);
  } catch (error) {
    if (statusId) safeSetText(statusId, `Falha: ${error.message}`);
    showToast(`Não consegui atualizar a senha: ${error.message}`, 'error');
  } finally {
    isChangingPassword = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
  }
}

// ---------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  safeSetText('app-version', APP_VERSION);
  initTxDatePicker();
  initReportDatePicker();
  populateAccountOptions();
  renderAll();
  renderNotifSettings();
  initAuth();

  window.addEventListener('online', () => {
    updateAuthConnectivityState();
    updateLiveIndicator();
    if (!me) return;
    if (offlineMode && ensureClient()) {
      // Voltou a internet: sai do modo cópia local e carrega de verdade.
      offlineMode = false;
      const c = ensureClient();
      c.auth.getSession().then(({ data }) => {
        if (data?.session?.user) bootstrapSession(data.session.user);
        else openLoginScreen('A internet voltou. Entre de novo para sincronizar.');
      }).catch(() => openLoginScreen('A internet voltou. Entre de novo para sincronizar.'));
      return;
    }
    setSyncStatus('Internet de volta. Enviando o que ficou guardado...', 'saving');
    flushQueue();
    if (realtimeStatus !== 'SUBSCRIBED') scheduleRealtimeRetry(500);
  });

  window.addEventListener('offline', () => {
    updateAuthConnectivityState();
    updateLiveIndicator();
    if (me) setSyncStatus('Sem internet. As alterações ficam guardadas neste aparelho.', 'warn', 'Nada se perde. Quando a conexão voltar, eu envio.');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !me || offlineMode) return;
    if (!navigator.onLine) return;
    flushQueue();
    if (realtimeStatus !== 'SUBSCRIBED') scheduleRealtimeRetry(300);
    else reloadFromCloud().catch(error => console.warn('Releitura ao voltar falhou:', error));
  });

  if ('serviceWorker' in navigator) {
    let refreshing = false;
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Só recarrega quando uma versão NOVA substitui a antiga; na primeira
      // visita não há versão antiga e recarregar só atrapalharia.
      if (refreshing || !hadController) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(registration => {
      registration.update();
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(error => console.log('Service worker não registrado:', error));
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown') && !e.target.closest('[id^="dropdown-"]')) closeAllDropdowns();
    if (!e.target.closest('#dashboard-month-picker') && !e.target.closest('[data-dashboard-month-toggle]')) closeDashboardMonthPicker();
    if (!e.target.closest('#tx-month-picker') && !e.target.closest('[data-tx-month-toggle]')) closeTxMonthPicker();
    if (!e.target.closest('#report-month-picker') && !e.target.closest('[data-report-month-toggle]')) closeReportMonthPicker();
    if (!e.target.closest('#control-month-picker') && !e.target.closest('#dropdown-control-period') && !e.target.closest('[onclick*="control-period"]')) closeControlMonthPicker();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAllDropdowns();
    closeDashboardMonthPicker();
    closeTxMonthPicker();
    closeReportMonthPicker();
    closeControlMonthPicker();
    toggleSidebar(false);
    closeModalTx();
    closeModalGoal();
    closeModalGoalAdd();
    closeDeleteModal();
    closeModalAccount();
  });
});
