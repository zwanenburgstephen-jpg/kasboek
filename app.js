(function () {
'use strict';

/* ================= helpers ================= */
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = (p) => (p || '') + Math.random().toString(36).slice(2, 9);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const nf = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(n, opts) {
  n = round2(n);
  const s = (n < 0 ? '−' : (opts && opts.plus && n > 0 ? '+' : '')) + '€ ' + nf.format(Math.abs(n));
  return s;
}
function moneyHtml(n, opts) {
  n = round2(n);
  const cls = n < 0 ? 'neg' : (opts && opts.posColor && n > 0 ? 'pos' : '');
  return `<span class="num ${cls}">${money(n, opts)}</span>`;
}
function signedHtml(t, amt) {
  // per-transaction display: expense negative, income positive, transfer neutral
  if (t.kind === 'expense') return `<span class="num neg">−€ ${nf.format(Math.abs(amt))}</span>`;
  if (t.kind === 'income') return `<span class="num pos">+€ ${nf.format(Math.abs(amt))}</span>`;
  return `<span class="num">↔ € ${nf.format(Math.abs(amt))}</span>`;
}

const pad2 = (n) => String(n).padStart(2, '0');
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayYM() { return todayISO().slice(0, 7); }
function todayDay() { return new Date().getDate(); }
function ymAdd(ym, n) { let [y, m] = ym.split('-').map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return `${y}-${pad2(m)}`; }
function ymCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
const MONTHS_NL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
const MONTHS_NL_SHORT = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
function monthName(ym) { const [y, m] = ym.split('-').map(Number); return MONTHS_NL[m - 1]; }
function monthLabel(ym, short) { const [y, m] = ym.split('-').map(Number); return (short ? MONTHS_NL_SHORT[m - 1] : MONTHS_NL[m - 1]) + ' ' + y; }
function dateLabel(iso) { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_NL_SHORT[m - 1]}`; }
function dateLabelFull(iso) { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_NL_SHORT[m - 1]} ${y}`; }
function ordDay(d) { return d == null ? '?' : (d + 'e'); }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ================= state ================= */
const S = {
  config: null, recurring: {}, months: {}, loans: {}, assets: {},
  ready: false, backend: null,
  view: { tab: 'maand', ym: todayYM(), accountFilter: null },
};
window.__KASBOEK_STATE = S; // debugging aid

/* ================= storage (Supabase, with offline cache + write queue) ================= */
const CACHE_KEY = 'kasboek-cache-v1';
const PENDING_KEY = 'kasboek-pending-v1';
const TABLE = 'kasboek_docs';

function applyLocal(target, p) {
  if (p.op === 'set') { if (p.coll === 'config') target.config = p.doc; else { target[p.coll] = target[p.coll] || {}; target[p.coll][p.id] = p.doc; } }
  else if (p.op === 'del') { if (p.coll !== 'config' && target[p.coll]) delete target[p.coll][p.id]; }
}

const Store = {
  sb: null, user: null, pending: [], syncing: false, flushing: null, lastSync: null, lastError: null, refreshTimer: null,
  configured() {
    const c = window.KASBOEK_CONFIG || {};
    return !!(c.supabaseUrl && /^https:\/\/.+\.supabase\.co\/?$/.test(c.supabaseUrl) && c.supabaseAnonKey && c.supabaseAnonKey.length > 40 && !/VUL/i.test(c.supabaseAnonKey));
  },
  async init() {
    this.loadPending();
    if (!this.configured() || typeof supabase === 'undefined') {
      S.backend = 'local'; this.loadCache(null); S.ready = true;
      const n = $('#notice-storage'); n.classList.remove('hidden');
      n.querySelector('.grow').textContent = 'Nog niet gekoppeld aan Supabase — je gegevens staan alleen op dit apparaat. Vul config.js in (zie README) om te synchroniseren.';
      renderShell(); return;
    }
    const c = window.KASBOEK_CONFIG;
    this.sb = supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    S.backend = 'supabase';
    try { const { data } = await this.sb.auth.getSession(); this.setUser(data && data.session ? data.session.user : null); } catch (e) { this.setUser(null); }
    this.sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') S.recovery = true;
      const u = session ? session.user : null;
      const changed = (u && u.id) !== (this.user && this.user.id);
      this.setUser(u);
      if (changed) { S.ready = !!u || S.ready; renderShell(); if (u) this.refresh(); }
      if (S.recovery && u) { S.recovery = false; setTimeout(() => newPasswordDialog(), 50); }
    });
    S.ready = true; renderShell();
    if (this.user) this.refresh();
    window.addEventListener('online', () => { setSync(); this.refresh(); });
    window.addEventListener('offline', () => setSync());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refresh(true); });
    window.addEventListener('focus', () => this.refresh(true));
    this.refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') this.refresh(true); }, 60000);
  },
  setUser(u) {
    this.user = u; S.user = u;
    if (u) this.loadCache(u.id); else { S.config = null; S.recurring = {}; S.months = {}; S.loans = {}; S.assets = {}; }
  },
  /* ---- local cache ---- */
  loadCache(uid) {
    try {
      const raw = localStorage.getItem(CACHE_KEY); if (!raw) return;
      const d = JSON.parse(raw); if ((d.uid || null) !== (uid || null)) return;
      S.config = d.config || null; S.recurring = d.recurring || {}; S.months = d.months || {}; S.loans = d.loans || {}; S.assets = d.assets || {};
      this.lastSync = d.lastSync || null;
    } catch (e) { /* ignore */ }
  },
  saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: this.user ? this.user.id : null, lastSync: this.lastSync, config: S.config, recurring: S.recurring, months: S.months, loans: S.loans, assets: S.assets })); } catch (e) { /* ignore */ }
  },
  loadPending() { try { this.pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch (e) { this.pending = []; } },
  savePending() { try { localStorage.setItem(PENDING_KEY, JSON.stringify(this.pending)); } catch (e) { /* ignore */ } },
  /* ---- writes ---- */
  async set(coll, id, doc) { this.write({ op: 'set', coll, id, doc: clone(doc) }); },
  async del(coll, id) { this.write({ op: 'del', coll, id }); },
  write(p) {
    applyLocal(S, p); render();
    this.pending = this.pending.filter(x => !(x.coll === p.coll && x.id === p.id)); this.pending.push(p);
    this.savePending(); this.saveCache(); setSync();
    if (S.backend === 'supabase') this.flush().catch(() => {});
  },
  setMany(list) { // list of {coll,id,doc}
    for (const x of list) { const p = { op: 'set', coll: x.coll, id: x.id, doc: clone(x.doc) }; applyLocal(S, p); this.pending = this.pending.filter(y => !(y.coll === p.coll && y.id === p.id)); this.pending.push(p); }
    render(); this.savePending(); this.saveCache(); setSync();
    if (S.backend === 'supabase') this.flush().catch(() => {});
  },
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!this.user || !navigator.onLine || !this.sb || !this.pending.length) return;
      setSync('syncing');
      try {
        const sets = this.pending.filter(p => p.op === 'set'); const dels = this.pending.filter(p => p.op === 'del');
        if (sets.length) {
          const rows = sets.map(p => ({ user_id: this.user.id, collection: p.coll, id: p.id, data: p.doc, updated_at: new Date().toISOString() }));
          const { error } = await this.sb.from(TABLE).upsert(rows, { onConflict: 'user_id,collection,id' });
          if (error) throw error;
          this.pending = this.pending.filter(p => !sets.includes(p)); this.savePending();
        }
        for (const p of dels) {
          const { error } = await this.sb.from(TABLE).delete().match({ user_id: this.user.id, collection: p.coll, id: p.id });
          if (error) throw error;
          this.pending = this.pending.filter(x => x !== p); this.savePending();
        }
        this.lastError = null;
      } catch (e) { this.lastError = e; console.warn('flush', e); }
      finally { setSync(); }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  },
  /* ---- read everything from the server ---- */
  async refresh(throttled) {
    if (!this.user || !navigator.onLine || !this.sb || this.syncing) return;
    if (throttled && this.lastSync && Date.now() - this.lastSync < 20000) return;
    this.syncing = true; setSync('syncing');
    try {
      await this.flush();
      if (this.pending.length) throw (this.lastError || new Error('pending'));
      const { data, error } = await this.sb.from(TABLE).select('collection,id,data');
      if (error) throw error;
      const next = { config: null, recurring: {}, months: {}, loans: {}, assets: {} };
      for (const row of data) {
        if (row.collection === 'config') { if (row.id === 'main') next.config = row.data; }
        else if (next[row.collection]) next[row.collection][row.id] = row.data;
      }
      Object.assign(S, next); this.lastSync = Date.now(); this.lastError = null; this.saveCache(); render();
    } catch (e) { this.lastError = e; console.warn('refresh', e); }
    finally { this.syncing = false; setSync(); }
  },
  /* ---- auth ---- */
  async signIn(email, password) { const { error } = await this.sb.auth.signInWithPassword({ email, password }); if (error) throw error; },
  async signUp(email, password) { const { data, error } = await this.sb.auth.signUp({ email, password }); if (error) throw error; return !!(data && data.session); },
  async resetPassword(email) { const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) throw error; },
  async updatePassword(password) { const { error } = await this.sb.auth.updateUser({ password }); if (error) throw error; },
  async signOut() { try { await this.sb.auth.signOut(); } catch (e) { /* ignore */ } localStorage.removeItem(CACHE_KEY); this.pending = []; this.savePending(); this.setUser(null); renderShell(); },
};

/* ---- sync indicator ---- */
function setSync(state) {
  const el = $('#sync'); if (!el) return;
  if (S.backend !== 'supabase') { el.textContent = 'lokaal'; el.className = 'sync local'; return; }
  const n = Store.pending.length;
  if (state === 'syncing') { el.textContent = 'synchroniseren…'; el.className = 'sync busy'; return; }
  if (!navigator.onLine) { el.textContent = n ? `offline · ${n} wijziging${n === 1 ? '' : 'en'} wachten` : 'offline'; el.className = 'sync off'; return; }
  if (n) { el.textContent = `${n} wijziging${n === 1 ? '' : 'en'} wachten`; el.className = 'sync warn'; el.title = Store.lastError ? String(Store.lastError.message || Store.lastError) : ''; return; }
  if (Store.lastSync) { const d = new Date(Store.lastSync); el.textContent = `gesynchroniseerd ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; el.className = 'sync ok'; return; }
  el.textContent = ''; el.className = 'sync';
}
/* ================= model / calculations ================= */
function accounts() {
  return ((S.config && S.config.accounts) || []).filter(a => !a.archived).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}
function allAccounts() { return ((S.config && S.config.accounts) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)); }
function acct(id) { return ((S.config && S.config.accounts) || []).find(a => a.id === id) || { id, name: id, short: id, color: '#999' }; }
function zeroBal() { const o = {}; accounts().forEach(a => { o[a.id] = 0; }); return o; }

function applyEffect(bal, t, amt) {
  amt = Number(amt) || 0;
  if (t.kind === 'income') bal[t.accountId] = (bal[t.accountId] || 0) + amt;
  else if (t.kind === 'transfer') { bal[t.accountId] = (bal[t.accountId] || 0) - amt; bal[t.toAccountId] = (bal[t.toAccountId] || 0) + amt; }
  else bal[t.accountId] = (bal[t.accountId] || 0) - amt;
}
function txAmount(t) { return t.status === 'confirmed' ? Number(t.actualAmount != null ? t.actualAmount : t.amount) : Number(t.amount); }
function txDay(t) {
  if (t.status === 'confirmed' && t.actualDate) return Number(t.actualDate.slice(8, 10));
  return t.day == null ? null : Number(t.day);
}

function templateActiveIn(tpl, ym) {
  if (!tpl.active) return false;
  if (tpl.from && ymCmp(ym, tpl.from) < 0) return false;
  if (tpl.until && ymCmp(ym, tpl.until) > 0) return false;
  return true;
}
function instanceFromTemplate(id, tpl, ym) {
  const dim = daysInMonth(ym);
  const t = {
    id: 'r-' + id, recurringId: id, name: tpl.name, kind: tpl.kind, accountId: tpl.accountId,
    amount: Number(tpl.amount) || 0, day: tpl.day == null ? null : Math.min(Number(tpl.day), dim),
    category: tpl.category || '', status: 'expected', note: tpl.note || '',
  };
  if (tpl.kind === 'transfer') t.toAccountId = tpl.toAccountId;
  return t;
}
function templateInstances(ym) {
  return Object.entries(S.recurring).filter(([id, tpl]) => templateActiveIn(tpl, ym)).map(([id, tpl]) => instanceFromTemplate(id, tpl, ym));
}
/* Bring a stored month in line with the recurring templates (only for months that are not in the past). */
function syncTransactions(ym, doc) {
  const cur = todayYM();
  if (ymCmp(ym, cur) < 0) return doc.transactions.slice();
  const dismissed = new Set(doc.dismissed || []);
  const out = [];
  const seen = new Set();
  for (const t of doc.transactions) {
    if (t.recurringId && t.status === 'expected' && !t.edited) {
      const tpl = S.recurring[t.recurringId];
      if (!tpl || !templateActiveIn(tpl, ym)) continue; // template gone or inactive -> drop the unedited expectation
      const fresh = instanceFromTemplate(t.recurringId, tpl, ym); fresh.id = t.id;
      out.push(fresh); seen.add(t.recurringId);
    } else { out.push(t); if (t.recurringId) seen.add(t.recurringId); }
  }
  for (const inst of templateInstances(ym)) {
    if (!seen.has(inst.recurringId) && !dismissed.has(inst.recurringId)) out.push(inst);
  }
  return out;
}
function firstYM() {
  const keys = Object.keys(S.months).sort();
  let f = keys[0] || null;
  if (S.config && S.config.firstMonth && (!f || ymCmp(S.config.firstMonth, f) < 0)) f = S.config.firstMonth;
  return f || todayYM();
}
/* Full picture of one month (memoised per render). */
let _memo = {};
function monthCalc(ym, depth) {
  if (_memo[ym]) return _memo[ym];
  depth = depth || 0;
  const stored = S.months[ym];
  const txs = stored ? syncTransactions(ym, stored) : templateInstances(ym);
  let opening;
  if (stored && stored.opening && Object.keys(stored.opening).length) {
    opening = Object.assign(zeroBal(), stored.opening);
  } else if (ymCmp(ym, firstYM()) <= 0 || depth > 240) {
    opening = zeroBal();
  } else {
    opening = Object.assign({}, monthCalc(ymAdd(ym, -1), depth + 1).closing);
  }
  const closing = Object.assign({}, opening);
  const now = Object.assign({}, opening);
  const isCur = ym === todayYM(); const td = todayDay();
  let inc = 0, out = 0, dueCount = 0, dueSum = 0;
  for (const t of txs) {
    if (t.status === 'skipped') continue;
    const amt = txAmount(t);
    applyEffect(closing, t, amt);
    if (t.kind === 'income') inc += amt; else if (t.kind === 'expense') out += amt;
    const past = ymCmp(ym, todayYM()) < 0;
    if (t.status === 'confirmed' || past) applyEffect(now, t, amt);
    else if (isCur && t.day != null && t.day <= td) { applyEffect(now, t, amt); dueCount++; dueSum += (t.kind === 'expense' ? -amt : amt); }
  }
  const res = { ym, stored: !!stored, doc: stored, txs, opening, closing, now, inc, out, dueCount, dueSum, hasOpeningOverride: !!(stored && stored.opening && Object.keys(stored.opening).length) };
  _memo[ym] = res; return res;
}
function isDue(t, ym) {
  if (t.status !== 'expected') return false;
  const cmp = ymCmp(ym, todayYM());
  if (cmp < 0) return true;
  if (cmp > 0) return false;
  return t.day != null && t.day <= todayDay();
}
function sum(obj) { return Object.values(obj).reduce((a, b) => a + (Number(b) || 0), 0); }

/* Make sure a month exists in storage before editing it. Returns a mutable copy. */
function materialize(ym) {
  const stored = S.months[ym];
  if (stored) { const d = clone(stored); d.transactions = syncTransactions(ym, d); d.dismissed = d.dismissed || []; return d; }
  return { transactions: templateInstances(ym), dismissed: [] };
}
function saveMonth(ym, doc) { return Store.set('months', ym, doc); }

/* net worth */
function netWorth() {
  const cur = monthCalc(todayYM());
  const bank = sum(cur.now);
  const loans = Object.values(S.loans).reduce((a, l) => a + (Number(l.balance) || 0), 0);
  const byType = { house: 0, investment: 0, other: 0 };
  Object.values(S.assets).forEach(a => { byType[a.type] = (byType[a.type] || 0) + (Number(a.value) || 0); });
  return { bank, loans, house: byType.house, investment: byType.investment, other: byType.other, total: bank + byType.house + byType.investment + byType.other - loans };
}

const CATEGORIES = ['Wonen', 'Verzekeringen', 'Abonnementen', 'Bankkosten', 'Zakelijk', 'Inkomen', 'Salaris', 'Overboeking', 'Leningen', 'Leefgeld', 'Boodschappen', 'Kleding', 'Leuke dingen', 'Auto', 'Overig'];
const PALETTE = ['#4B5B7A', '#009286', '#3FB39A', '#FF6200', '#C24E00', '#1F3A93', '#7B4FA3', '#B8860B', '#2F855A', '#C53030', '#4A5568', '#D53F8C'];
/* ================= rendering ================= */
function acctPill(t) {
  const a = acct(t.accountId);
  let h = `<span class="acct-pill" style="--acc-color:${esc(a.color)}"><span class="dot"></span>${esc(a.short || a.name)}`;
  if (t.kind === 'transfer' && t.toAccountId) { const b = acct(t.toAccountId); h += ` <span class="arrow">→</span> <span class="dot" style="--acc-color:${esc(b.color)};background:${esc(b.color)}"></span>${esc(b.short || b.name)}`; }
  return h + '</span>';
}
function statusPill(t, ym) {
  if (t.status === 'confirmed') return `<span class="status confirmed">✓ Bevestigd</span>`;
  if (t.status === 'skipped') return `<span class="status skipped">Overgeslagen</span>`;
  if (isDue(t, ym)) return `<span class="status due">● Te bevestigen</span>`;
  return `<span class="status future">Verwacht</span>`;
}

function render() {
  _memo = {};
  if (!S.ready) return;
  $('#loading').classList.add('hidden');
  const n = accounts().length;
  $('#brand-sub').textContent = n ? `${n} rekening${n === 1 ? '' : 'en'}` : 'nog geen rekeningen';
  // due badge
  const cur = monthCalc(todayYM());
  const badge = $('#due-badge');
  if (cur.dueCount) { badge.textContent = cur.dueCount; badge.classList.remove('hidden'); } else badge.classList.add('hidden');
  $$('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.view.tab)));
  $$('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + S.view.tab; });
  const R = { maand: renderMonth, prognose: renderForecast, vast: renderRecurring, leningen: renderLoans, woning: () => renderAssets('house'), beleggingen: () => renderAssets('investment'), overig: () => renderAssets('other'), instellingen: renderSettings };
  (R[S.view.tab] || renderMonth)();
}

function noAccountsHtml() {
  return `<div class="card"><div class="empty"><strong>Nog geen rekeningen</strong>Voeg je bankrekeningen toe onder Instellingen, daarna kun je vaste lasten en uitgaven bijhouden.<div style="margin-top:12px"><button class="btn primary" data-act="go-settings">Naar instellingen</button></div></div></div>`;
}

/* ---------- Month ---------- */
function renderMonth() {
  const p = $('#panel-maand');
  if (!accounts().length) { p.innerHTML = noAccountsHtml(); return; }
  const ym = S.view.ym, cur = todayYM(), cmp = ymCmp(ym, cur);
  const M = monthCalc(ym);
  const accs = accounts();
  const filt = S.view.accountFilter;

  const [y, m] = ym.split('-');
  let h = `<div class="month-head">
    <div class="month-nav">
      <button class="btn icon ghost" data-act="prev" aria-label="Vorige maand">‹</button>
      <div class="month-title">${esc(monthName(ym))} <span class="yr">${esc(y)}</span></div>
      <button class="btn icon ghost" data-act="next" aria-label="Volgende maand">›</button>
    </div>
    ${cmp === 0 ? `<span class="chip accent">Huidige maand · ${todayDay()} ${MONTHS_NL_SHORT[Number(m) - 1]}</span>` : cmp > 0 ? `<span class="chip">Prognose</span>` : `<span class="chip">Afgesloten periode</span>`}
    ${M.hasOpeningOverride ? `<span class="chip" title="Beginsaldo's zijn handmatig ingevoerd">Beginsaldo vastgezet</span>` : ''}
    <div class="actions">
      ${cmp !== 0 ? `<button class="btn ghost" data-act="today">Vandaag</button>` : ''}
      <button class="btn" data-act="opening">Beginsaldo's</button>
      <button class="btn primary" data-act="add">+ Toevoegen</button>
    </div>
  </div>`;

  // tiles: one per account; the key figure is "now" for the current month, otherwise the closing balance
  const keyLabel = cmp === 0 ? 'Nu (geschat)' : cmp > 0 ? 'Einde (prognose)' : 'Eindsaldo';
  h += `<div class="tiles">`;
  for (const a of accs) {
    const o = M.opening[a.id] || 0, e = M.closing[a.id] || 0, nw = M.now[a.id] || 0;
    h += `<button class="tile" style="--acc-color:${esc(a.color)}" data-act="filter" data-id="${esc(a.id)}" aria-pressed="${filt === a.id}" title="Filter op ${esc(a.name)}">
      <div class="name"><span class="dot"></span>${esc(a.name)}</div>
      <div class="kl">${keyLabel}</div><div class="kv">${moneyHtml(cmp === 0 ? nw : e)}</div>
      <div class="sr"><span class="l">Begin</span><span class="v">${moneyHtml(o)}</span></div>
      ${cmp === 0 ? `<div class="sr"><span class="l">Einde verwacht</span><span class="v">${moneyHtml(e)}</span></div>` : ''}
    </button>`;
  }
  h += `</div>`;
  const tO = sum(M.opening), tE = sum(M.closing), tN = sum(M.now);
  h += `<div class="totals"><span class="t">Alle rekeningen</span>
    <span class="item"><span class="l">Begin</span><span class="v">${moneyHtml(tO)}</span></span>
    ${cmp === 0 ? `<span class="item big"><span class="l">Nu (geschat)</span><span class="v">${moneyHtml(tN)}</span></span>` : ''}
    <span class="item ${cmp === 0 ? '' : 'big'}"><span class="l">${cmp === 0 ? 'Einde verwacht' : cmp > 0 ? 'Einde (prognose)' : 'Einde'}</span><span class="v">${moneyHtml(tE)}</span></span>
    <span class="item"><span class="l">Verschil</span><span class="v">${moneyHtml(tE - tO, { plus: true, posColor: true })}</span></span>
  </div>`;

  // due banner
  if (cmp === 0 && M.dueCount) {
    h += `<div class="notice"><span>●</span><span class="grow"><b>${M.dueCount} post${M.dueCount === 1 ? '' : 'en'} te bevestigen</b> — de datum is voorbij, dus ze tellen al mee in het geschatte saldo (${money(M.dueSum, { plus: true })}). Bevestig ze zodra je ze op je afschrift ziet.</span><button class="btn sm" data-act="confirm-all">Alles bevestigen</button></div>`;
  }
  if (cmp > 0) {
    h += `<div class="notice info"><span>◔</span><span class="grow">Prognose op basis van je vaste lasten. Voeg hier alvast bekende uitgaven of inkomsten toe; ze tellen direct mee in de verwachte saldo's.</span></div>`;
  }

  // ledger
  let txs = M.txs.slice();
  if (filt) txs = txs.filter(t => t.accountId === filt || t.toAccountId === filt);
  const dayOf = (t) => { const d = txDay(t); return d == null ? 99 : d; };
  txs.sort((a, b) => dayOf(a) - dayOf(b) || a.name.localeCompare(b.name, 'nl'));
  const groups = [];
  if (cmp > 0) groups.push(['Verwachte posten', txs.filter(t => t.status !== 'skipped')]);
  else {
    groups.push(['Te bevestigen', txs.filter(t => isDue(t, ym))]);
    if (cmp === 0) groups.push(['Nog verwacht deze maand', txs.filter(t => t.status === 'expected' && !isDue(t, ym))]);
    groups.push(['Bevestigd', txs.filter(t => t.status === 'confirmed')]);
  }
  groups.push(['Overgeslagen', txs.filter(t => t.status === 'skipped')]);

  h += `<div class="card"><div class="card-head"><h2>${filt ? esc(acct(filt).name) : 'Alle rekeningen'}</h2>
    ${filt ? `<button class="btn sm ghost" data-act="filter" data-id="${esc(filt)}">Filter wissen ×</button>` : ''}
    <span class="grow"></span>
    <span class="chip pos">In ${money(M.inc)}</span><span class="chip">Uit ${money(M.out)}</span><span class="chip ${M.inc - M.out >= 0 ? 'pos' : 'warn'}">Netto ${money(M.inc - M.out, { plus: true })}</span>
  </div><div class="table-wrap"><table class="ledger"><thead><tr>
    <th class="day">Dag</th><th>Omschrijving</th><th class="hide-m">Rekening</th><th class="r">Bedrag</th><th class="hide-m">Status</th><th class="act"></th></tr></thead><tbody>`;
  let any = false;
  for (const [title, list] of groups) {
    if (!list.length) continue; any = true;
    h += `<tr class="section-row"><td colspan="6">${esc(title)} · ${list.length}</td></tr>`;
    for (const t of list) {
      const due = isDue(t, ym);
      const cls = t.status === 'skipped' ? 'skipped' : due ? 'due' : t.status === 'expected' ? 'future' : '';
      const dayTxt = t.status === 'confirmed' ? (t.actualDate ? dateLabel(t.actualDate) : '—') : ordDay(t.day);
      const amt = txAmount(t);
      const diff = (t.status === 'confirmed' && t.recurringId && Math.abs(Number(t.actualAmount) - Number(t.amount)) > 0.004) ? `<span class="small muted"> (verwacht ${money(t.amount)})</span>` : '';
      h += `<tr class="${cls}" data-id="${esc(t.id)}">
        <td class="day num">${esc(dayTxt)}</td>
        <td class="desc">${esc(t.name)}${t.recurringId ? ' <span class="muted" title="Vaste last">↻</span>' : ''}<span class="cat">${esc([t.category, t.note].filter(Boolean).join(' · '))}</span></td>
        <td class="acct hide-m">${acctPill(t)}</td>
        <td class="r amt">${signedHtml(t, amt)}${diff}</td>
        <td class="hide-m">${statusPill(t, ym)}</td>
        <td class="act">
          ${t.status === 'expected' ? `<button class="btn sm primary" data-act="confirm" data-id="${esc(t.id)}">Bevestigen</button>` : ''}
          ${t.status === 'skipped' ? `<button class="btn sm" data-act="unskip" data-id="${esc(t.id)}">Terugzetten</button>` : ''}
          <button class="btn sm ghost" data-act="edit" data-id="${esc(t.id)}">Bewerken</button>
        </td></tr>`;
    }
  }
  if (!any) h += `<tr><td colspan="6"><div class="empty"><strong>Geen posten</strong>${filt ? 'Niets op deze rekening in deze maand.' : 'Voeg een uitgave of inkomst toe met “+ Toevoegen”.'}</div></td></tr>`;
  h += `</tbody></table></div></div>`;
  p.innerHTML = h;
}

/* ---------- Forecast ---------- */
function renderForecast() {
  const p = $('#panel-prognose');
  if (!accounts().length) { p.innerHTML = noAccountsHtml(); return; }
  const accs = accounts(); const cur = todayYM();
  const start = ymAdd(cur, -1);
  const months = []; for (let i = 0; i < 14; i++) months.push(ymAdd(start, i));
  let h = `<div class="panel-head"><h2>Prognose</h2><p>Verwacht eindsaldo per rekening, per maand. Vaste lasten lopen automatisch door; eenmalige posten die je in een toekomstige maand zet, tellen mee.</p></div>`;
  h += `<div class="card"><div class="table-wrap"><table class="grid"><thead><tr><th>Maand</th>`;
  for (const a of accs) h += `<th><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.short || a.name)}</th>`;
  h += `<th class="tot">Totaal</th><th>In</th><th>Uit</th><th>Netto</th></tr></thead><tbody>`;
  for (const ym of months) {
    const M = monthCalc(ym);
    const isCur = ym === cur;
    h += `<tr class="${isCur ? 'current' : ''}"><td class="mon"><button data-act="goto" data-ym="${ym}">${esc(monthLabel(ym, true))}</button>${isCur ? ' <span class="small muted">nu</span>' : ''}${M.stored && !isCur && ymCmp(ym, cur) > 0 ? ' <span class="small muted" title="Bevat handmatig toegevoegde posten">•</span>' : ''}</td>`;
    for (const a of accs) h += `<td>${moneyHtml(M.closing[a.id] || 0)}</td>`;
    h += `<td class="tot">${moneyHtml(sum(M.closing))}</td><td>${moneyHtml(M.inc)}</td><td>${moneyHtml(-M.out)}</td><td>${moneyHtml(M.inc - M.out, { plus: true, posColor: true })}</td></tr>`;
  }
  h += `</tbody></table></div></div>`;
  // yearly summary of recurring
  const tpls = Object.values(S.recurring).filter(t => t.active);
  const mIn = tpls.filter(t => t.kind === 'income').reduce((a, t) => a + Number(t.amount || 0), 0);
  const mOut = tpls.filter(t => t.kind === 'expense').reduce((a, t) => a + Number(t.amount || 0), 0);
  h += `<div class="stats" style="margin-top:16px">
    <div class="stat"><div class="l">Vaste inkomsten / maand</div><div class="v num pos">${money(mIn)}</div></div>
    <div class="stat"><div class="l">Vaste lasten / maand</div><div class="v num">${money(mOut)}</div><div class="s">${money(mOut * 12)} per jaar</div></div>
    <div class="stat ${mIn - mOut >= 0 ? 'hi' : ''}"><div class="l">Vrije ruimte / maand</div><div class="v num ${mIn - mOut < 0 ? 'neg' : ''}">${money(mIn - mOut, { plus: true })}</div><div class="s">zonder eenmalige uitgaven</div></div>
  </div>`;
  p.innerHTML = h;
}

/* ---------- Recurring templates ---------- */
function renderRecurring() {
  const p = $('#panel-vast');
  if (!accounts().length) { p.innerHTML = noAccountsHtml(); return; }
  const list = Object.entries(S.recurring).map(([id, t]) => Object.assign({ id }, t));
  list.sort((a, b) => (b.active - a.active) || ((a.day == null ? 99 : a.day) - (b.day == null ? 99 : b.day)) || a.name.localeCompare(b.name, 'nl'));
  const act = list.filter(t => t.active);
  const mIn = act.filter(t => t.kind === 'income').reduce((a, t) => a + Number(t.amount || 0), 0);
  const mOut = act.filter(t => t.kind === 'expense').reduce((a, t) => a + Number(t.amount || 0), 0);
  let h = `<div class="panel-head"><h2>Vaste lasten</h2><p>Alles wat elke maand rond dezelfde dag terugkomt. Wijzigingen gelden voor de huidige en toekomstige maanden; bevestigde posten blijven zoals ze zijn.</p>
    <div class="actions"><button class="btn primary" data-act="add-tpl">+ Vaste last</button></div></div>`;
  h += `<div class="stats"><div class="stat"><div class="l">Actief</div><div class="v">${act.length} <span class="small muted">van ${list.length}</span></div></div>
    <div class="stat"><div class="l">Vaste inkomsten</div><div class="v num pos">${money(mIn)}</div></div>
    <div class="stat"><div class="l">Vaste uitgaven</div><div class="v num">${money(mOut)}</div></div>
    <div class="stat"><div class="l">Overboekingen</div><div class="v num">${money(act.filter(t => t.kind === 'transfer').reduce((a, t) => a + Number(t.amount || 0), 0))}</div><div class="s">tussen eigen rekeningen</div></div></div>`;
  h += `<div class="card"><div class="table-wrap"><table class="ledger"><thead><tr><th class="day">Dag</th><th>Omschrijving</th><th class="hide-m">Rekening</th><th class="r">Bedrag</th><th class="hide-m">Categorie</th><th>Actief</th><th class="act"></th></tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="7"><div class="empty"><strong>Nog geen vaste lasten</strong>Voeg je huur/hypotheek, verzekeringen en abonnementen toe.</div></td></tr>`;
  for (const t of list) {
    h += `<tr class="${t.active ? '' : 'rec-off'}">
      <td class="day num">${esc(ordDay(t.day))}${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ''}</td>
      <td class="desc">${esc(t.name)}${(t.from && ymCmp(t.from, firstYM()) > 0) || t.until ? `<span class="cat">${t.from && ymCmp(t.from, firstYM()) > 0 ? 'vanaf ' + esc(monthLabel(t.from, true)) : ''}${t.until ? ' t/m ' + esc(monthLabel(t.until, true)) : ''}</span>` : ''}</td>
      <td class="acct hide-m">${acctPill(t)}</td>
      <td class="r amt">${signedHtml(t, t.amount)}</td>
      <td class="hide-m muted">${esc(t.category || '')}</td>
      <td><input type="checkbox" class="switch" data-act="toggle-tpl" data-id="${esc(t.id)}" ${t.active ? 'checked' : ''} aria-label="Actief"></td>
      <td class="act"><button class="btn sm ghost" data-act="edit-tpl" data-id="${esc(t.id)}">Bewerken</button></td></tr>`;
  }
  h += `</tbody></table></div></div>`;
  p.innerHTML = h;
}

/* ---------- Net worth strip ---------- */
function worthStrip() {
  const w = netWorth();
  return `<div class="worth"><span>Banksaldi <b class="num">${money(w.bank)}</b></span><span class="op">+</span><span>Woning <b class="num">${money(w.house)}</b></span><span class="op">+</span><span>Beleggingen <b class="num">${money(w.investment)}</b></span><span class="op">+</span><span>Overig <b class="num">${money(w.other)}</b></span><span class="op">−</span><span>Leningen <b class="num">${money(w.loans)}</b></span><span class="eq">Netto vermogen <b class="num ${w.total < 0 ? 'neg' : ''}">${money(w.total)}</b></span></div>`;
}

/* ---------- Loans ---------- */
function renderLoans() {
  const p = $('#panel-leningen');
  const list = Object.entries(S.loans).map(([id, l]) => Object.assign({ id }, l)).sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0));
  const tot = list.reduce((a, l) => a + (Number(l.balance) || 0), 0);
  const mon = list.reduce((a, l) => a + (Number(l.monthly) || 0), 0);
  const orig = list.reduce((a, l) => a + (Number(l.original) || 0), 0);
  let h = `<div class="panel-head"><h2>Leningen</h2><p>Hypotheek, autolening, persoonlijke lening. Je werkt het openstaande saldo zelf bij, bijvoorbeeld na het jaaroverzicht.</p>
    <div class="actions"><button class="btn primary" data-act="add-loan">+ Lening</button></div></div>`;
  h += worthStrip();
  h += `<div class="stats"><div class="stat hi"><div class="l">Totaal openstaand</div><div class="v num">${money(tot)}</div>${orig ? `<div class="s">${Math.round((1 - tot / orig) * 100)}% van ${money(orig)} afgelost</div>` : ''}</div>
    <div class="stat"><div class="l">Maandlasten</div><div class="v num">${money(mon)}</div><div class="s">${money(mon * 12)} per jaar</div></div>
    <div class="stat"><div class="l">Aantal</div><div class="v">${list.length}</div></div></div>`;
  h += `<div class="card"><div class="table-wrap"><table class="ledger"><thead><tr><th>Lening</th><th class="hide-m">Verstrekker</th><th class="r">Openstaand</th><th class="r hide-m">Oorspronkelijk</th><th class="r hide-m">Rente</th><th class="r">Per maand</th><th class="hide-m">Einddatum</th><th class="hide-m">Bijgewerkt</th><th class="act"></th></tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="9"><div class="empty"><strong>Nog geen leningen</strong>Voeg je hypotheek of andere leningen toe om ze in je vermogen mee te tellen.</div></td></tr>`;
  for (const l of list) {
    h += `<tr><td class="desc">${esc(l.name)}<span class="cat">${esc(l.note || '')}</span></td><td class="hide-m muted">${esc(l.lender || '')}</td>
      <td class="r amt">${moneyHtml(Number(l.balance) || 0)}</td><td class="r hide-m muted num">${l.original ? money(l.original) : '—'}</td>
      <td class="r hide-m num">${l.rate != null && l.rate !== '' ? esc(String(l.rate).replace('.', ',')) + ' %' : '—'}</td>
      <td class="r num">${l.monthly ? money(l.monthly) : '—'}</td><td class="hide-m muted">${l.endDate ? esc(dateLabelFull(l.endDate)) : '—'}</td>
      <td class="hide-m muted">${esc(dateLabel(l.updated))}</td>
      <td class="act"><button class="btn sm ghost" data-act="edit-loan" data-id="${esc(l.id)}">Bewerken</button></td></tr>`;
  }
  h += `</tbody></table></div></div>`;
  p.innerHTML = h;
}

/* ---------- Assets (house / investment / other) ---------- */
const ASSET_META = {
  house: { title: 'Woning', intro: 'De geschatte waarde van je woning. Koppel de hypotheek om de overwaarde te zien; werk de waarde bij als je een nieuwe WOZ-beschikking of taxatie hebt.', add: '+ Woning', empty: 'Voeg je woning toe met de geschatte marktwaarde en eventueel de WOZ-waarde.' },
  investment: { title: 'Beleggingen', intro: 'Aandelen, ETF’s, crypto, pensioenbeleggingen. Vul de inleg en de huidige waarde in; het rendement wordt berekend.', add: '+ Belegging', empty: 'Voeg een broker, fonds of portefeuille toe.' },
  other: { title: 'Overige bezittingen', intro: 'Auto, motor, boot, spaardeposito, vorderingen — alles wat waarde heeft en niet op een bankrekening staat.', add: '+ Bezitting', empty: 'Voeg een bezitting toe met de huidige waarde.' },
};
function histHtml(hist) {
  if (!hist || hist.length < 2) return '';
  const vals = hist.map(x => Number(x.value) || 0); const max = Math.max(...vals, 1);
  return `<div class="hist" title="Waardeverloop">${hist.slice(-12).map(x => `<span style="height:${Math.max(8, Math.round((Number(x.value) || 0) / max * 100))}%"></span>`).join('')}</div>`;
}
function renderAssets(type) {
  const p = $('#panel-' + (type === 'house' ? 'woning' : type === 'investment' ? 'beleggingen' : 'overig'));
  const meta = ASSET_META[type];
  const list = Object.entries(S.assets).filter(([id, a]) => a.type === type).map(([id, a]) => Object.assign({ id }, a)).sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  const tot = list.reduce((a, x) => a + (Number(x.value) || 0), 0);
  let h = `<div class="panel-head"><h2>${meta.title}</h2><p>${meta.intro}</p><div class="actions"><button class="btn primary" data-act="add-asset" data-type="${type}">${meta.add}</button></div></div>`;
  h += worthStrip();
  if (type === 'house') {
    const loanTot = list.reduce((a, x) => a + (x.loanId && S.loans[x.loanId] ? Number(S.loans[x.loanId].balance) || 0 : 0), 0);
    h += `<div class="stats"><div class="stat hi"><div class="l">Waarde woning(en)</div><div class="v num">${money(tot)}</div></div>
      <div class="stat"><div class="l">Gekoppelde hypotheek</div><div class="v num">${money(loanTot)}</div></div>
      <div class="stat"><div class="l">Overwaarde</div><div class="v num ${tot - loanTot < 0 ? 'neg' : 'pos'}">${money(tot - loanTot)}</div></div></div>`;
  } else if (type === 'investment') {
    const inv = list.reduce((a, x) => a + (Number(x.invested) || 0), 0);
    h += `<div class="stats"><div class="stat hi"><div class="l">Huidige waarde</div><div class="v num">${money(tot)}</div></div>
      <div class="stat"><div class="l">Totale inleg</div><div class="v num">${money(inv)}</div></div>
      <div class="stat"><div class="l">Rendement</div><div class="v num ${tot - inv < 0 ? 'neg' : 'pos'}">${money(tot - inv, { plus: true })}</div>${inv ? `<div class="s">${((tot - inv) / inv * 100).toFixed(1).replace('.', ',')} %</div>` : ''}</div></div>`;
  } else {
    h += `<div class="stats"><div class="stat hi"><div class="l">Totale waarde</div><div class="v num">${money(tot)}</div></div><div class="stat"><div class="l">Aantal</div><div class="v">${list.length}</div></div></div>`;
  }
  h += `<div class="card"><div class="table-wrap"><table class="ledger"><thead><tr><th>Naam</th>`;
  if (type === 'house') h += `<th class="r hide-m">WOZ-waarde</th><th class="r">Waarde</th><th class="hide-m">Hypotheek</th><th class="r hide-m">Overwaarde</th>`;
  else if (type === 'investment') h += `<th class="hide-m">Platform</th><th class="r hide-m">Inleg</th><th class="r">Waarde</th><th class="r hide-m">Rendement</th>`;
  else h += `<th class="r">Waarde</th>`;
  h += `<th class="hide-m">Verloop</th><th class="hide-m">Peildatum</th><th class="act"></th></tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="9"><div class="empty"><strong>Nog niets toegevoegd</strong>${meta.empty}</div></td></tr>`;
  for (const a of list) {
    const v = Number(a.value) || 0;
    h += `<tr><td class="desc">${esc(a.name)}<span class="cat">${esc(a.note || '')}</span></td>`;
    if (type === 'house') {
      const ln = a.loanId && S.loans[a.loanId]; const lb = ln ? Number(ln.balance) || 0 : 0;
      h += `<td class="r hide-m num muted">${a.woz ? money(a.woz) : '—'}</td><td class="r amt">${moneyHtml(v)}</td><td class="hide-m muted">${ln ? esc(ln.name) : '—'}</td><td class="r hide-m num ${v - lb < 0 ? 'neg' : 'pos'}">${ln ? money(v - lb) : '—'}</td>`;
    } else if (type === 'investment') {
      const inv = Number(a.invested) || 0;
      h += `<td class="hide-m muted">${esc(a.platform || '')}</td><td class="r hide-m num muted">${inv ? money(inv) : '—'}</td><td class="r amt">${moneyHtml(v)}</td><td class="r hide-m num ${v - inv < 0 ? 'neg' : 'pos'}">${inv ? money(v - inv, { plus: true }) : '—'}</td>`;
    } else h += `<td class="r amt">${moneyHtml(v)}</td>`;
    h += `<td class="hide-m">${histHtml(a.history)}</td><td class="hide-m muted">${esc(dateLabelFull(a.date))}</td>
      <td class="act"><button class="btn sm ghost" data-act="edit-asset" data-id="${esc(a.id)}">Bewerken</button></td></tr>`;
  }
  h += `</tbody></table></div></div>`;
  p.innerHTML = h;
}

/* ---------- Settings ---------- */
function renderSettings() {
  const p = $('#panel-instellingen');
  const accs = allAccounts();
  let h = `<div class="panel-head"><h2>Instellingen</h2><p>Je rekeningen en de volgorde waarin ze worden getoond. Een rekeningnummer is optioneel en alleen voor jezelf.</p>
    <div class="actions"><button class="btn primary" data-act="add-acct">+ Rekening</button></div></div>`;
  h += `<div class="card" style="padding:12px"><div class="acct-list">`;
  if (!accs.length) h += `<div class="empty"><strong>Nog geen rekeningen</strong>Begin met je eerste bankrekening.</div>`;
  accs.forEach((a, i) => {
    h += `<div class="acct-row" style="--acc-color:${esc(a.color)}">
      <span class="acct-pill"><span class="dot"></span><b>${esc(a.name)}</b></span><span class="muted small">${esc(a.short || '')}</span><span class="iban">${esc(a.iban || '')}</span>
      ${a.archived ? '<span class="chip">gearchiveerd</span>' : ''}<span class="grow"></span>
      <button class="btn sm ghost icon" data-act="acct-up" data-id="${esc(a.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Omhoog">↑</button>
      <button class="btn sm ghost icon" data-act="acct-down" data-id="${esc(a.id)}" ${i === accs.length - 1 ? 'disabled' : ''} aria-label="Omlaag">↓</button>
      <button class="btn sm ghost" data-act="edit-acct" data-id="${esc(a.id)}">Bewerken</button></div>`;
  });
  h += `</div></div>`;
  const first = S.config && S.config.firstMonth;
  h += `<div class="stats" style="margin-top:16px">
    <div class="stat"><div class="l">Eerste maand</div><div class="v">${first ? esc(monthLabel(first)) : '—'}</div><div class="s">Vanaf hier lopen de saldo's door</div></div>
    <div class="stat"><div class="l">Opslag</div><div class="v">${S.backend === 'db' ? 'Claude-opslag' : S.backend === 'supabase' ? 'Supabase' : 'Deze browser'}</div><div class="s">${S.backend === 'local' ? 'Alleen lokaal bewaard' : 'Gedeeld tussen je apparaten'}</div></div>
    <div class="stat"><div class="l">Vaste lasten</div><div class="v">${Object.keys(S.recurring).length}</div></div>
    <div class="stat"><div class="l">Maanden met gegevens</div><div class="v">${Object.keys(S.months).length}</div></div></div>`;
  if (typeof settingsExtraHtml === 'function') h += settingsExtraHtml();
  p.innerHTML = h;
}
/* ================= dialogs ================= */
const dlg = () => $('#dlg');
function openDialog(html, setup) {
  const d = dlg(); d.innerHTML = html; if (setup) setup(d); if (!d.open) d.showModal();
  const first = d.querySelector('input:not([type=hidden]):not([type=checkbox]), select'); if (first) first.focus();
}
function closeDialog() { const d = dlg(); if (d.open) d.close(); d.innerHTML = ''; }

function parseAmount(s) {
  s = String(s == null ? '' : s).trim().replace(/[€\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  return Number(s);
}
function fmtInput(n) { if (n == null || n === '' || isNaN(Number(n))) return ''; return Number(n).toFixed(2).replace('.', ','); }
function field(label, inner, hint, opt) {
  return `<div class="field"><label>${esc(label)}${opt ? ' <span class="opt">(optioneel)</span>' : ''}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}
function amountInput(name, value, extra) { return `<div class="amount-prefix"><input name="${name}" type="text" inputmode="decimal" value="${esc(fmtInput(value))}" placeholder="0,00" ${extra || ''}></div>`; }
function accountSelect(name, value, opts) {
  opts = opts || {};
  let h = `<select name="${name}">`; if (opts.none) h += `<option value="">${esc(opts.none)}</option>`;
  accounts().forEach(a => { h += `<option value="${esc(a.id)}" ${a.id === value ? 'selected' : ''}>${esc(a.name)}</option>`; });
  return h + '</select>';
}
function segment(name, options, value) {
  return `<input type="hidden" name="${name}" value="${esc(value)}"><div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === value}">${esc(l)}</button>`).join('')}</div>`;
}
function wireSegments(root, onChange) {
  $$('.seg', root).forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    $$('button', seg).forEach(x => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true');
    const inp = root.querySelector(`input[name="${seg.dataset.seg}"]`); inp.value = b.dataset.v;
    if (onChange) onChange(seg.dataset.seg, b.dataset.v);
  }));
}
const catList = () => `<datalist id="cats">${CATEGORIES.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
function dlgShell(title, sub, body, foot) {
  return `<form method="dialog" novalidate><div class="dlg-head"><h3>${esc(title)}</h3>${sub ? `<span class="muted">${sub}</span>` : ''}</div><div class="dlg-body">${body}</div><div class="dlg-foot">${foot}</div></form>`;
}
function defaultDate(ym) {
  const c = ymCmp(ym, todayYM());
  if (c === 0) return todayISO();
  return ym + '-01';
}
function clampDateToMonth(iso, ym) {
  if (!iso || iso.slice(0, 7) === ym) return iso || null;
  const d = Number(iso.slice(8, 10)) || 1;
  return ym + '-' + pad2(Math.min(d, daysInMonth(ym)));
}

/* ---------- transaction add / edit ---------- */
function txDialog(ym, existing) {
  const isNew = !existing;
  const accs = accounts();
  const t = existing ? clone(existing) : { id: uid('t'), name: '', kind: 'expense', accountId: accs[0].id, toAccountId: (accs[1] || accs[0]).id, amount: '', category: '', note: '', status: ymCmp(ym, todayYM()) > 0 ? 'expected' : 'confirmed' };
  const date = existing ? (t.status === 'confirmed' && t.actualDate ? t.actualDate : (t.day != null ? ym + '-' + pad2(t.day) : '')) : defaultDate(ym);
  const shownAmount = existing && t.status === 'confirmed' && t.actualAmount != null ? t.actualAmount : t.amount;
  const isRec = !!t.recurringId;
  const body = `
    ${field('Omschrijving', `<input name="name" type="text" value="${esc(t.name)}" placeholder="Bijv. Boodschappen" required>`)}
    ${field('Soort', segment('kind', [['expense', 'Uitgave'], ['income', 'Inkomst'], ['transfer', 'Overboeking']], t.kind))}
    <div class="row2">${field(t.kind === 'transfer' ? 'Van rekening' : 'Rekening', accountSelect('accountId', t.accountId))}
      <div id="to-wrap" class="${t.kind === 'transfer' ? '' : 'hidden'}">${field('Naar rekening', accountSelect('toAccountId', t.toAccountId))}</div></div>
    <div class="row2">${field('Bedrag', amountInput('amount', shownAmount, 'required'), isRec && existing.status === 'confirmed' && Math.abs(Number(existing.amount) - Number(existing.actualAmount)) > 0.004 ? `Verwacht was ${esc(money(existing.amount))}` : '')}
      ${field('Datum', `<input name="date" type="date" value="${esc(date)}" min="${ym}-01" max="${ym}-${pad2(daysInMonth(ym))}">`, t.status === 'expected' ? 'Verwachte dag; bepaalt wanneer de post in de schatting meetelt' : '')}</div>
    ${field('Status', segment('status', [['confirmed', 'Bevestigd'], ['expected', 'Nog verwacht']], t.status === 'skipped' ? 'expected' : t.status))}
    <div class="row2">${field('Categorie', `<input name="category" type="text" list="cats" value="${esc(t.category || '')}">${catList()}`, '', true)}
      ${field('Notitie', `<input name="note" type="text" value="${esc(t.note || '')}">`, '', true)}</div>
    ${isNew ? `<label class="check"><input type="checkbox" name="repeat"> Elke maand herhalen — wordt een vaste last</label>` : ''}
    ${isRec ? `<div class="hint">↻ Dit is een vaste last. Wat je hier wijzigt geldt alleen voor ${esc(monthLabel(ym))}. Het vaste bedrag of de dag pas je aan onder <b>Vaste lasten</b>.</div>` : ''}`;
  const foot = `${!isNew ? `<button type="button" class="btn ghost danger" data-act="dlg-delete">${isRec ? 'Deze maand weglaten' : 'Verwijderen'}</button>` : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Opslaan</button>`;
  openDialog(dlgShell(isNew ? 'Post toevoegen' : 'Post bewerken', esc(monthLabel(ym)), body, foot), (d) => {
    wireSegments(d, (n, v) => { if (n === 'kind') { $('#to-wrap', d).classList.toggle('hidden', v !== 'transfer'); d.querySelector('[name=accountId]').closest('.field').querySelector('label').textContent = v === 'transfer' ? 'Van rekening' : 'Rekening'; } });
    const form = $('form', d);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const name = String(f.get('name') || '').trim(); const amount = parseAmount(f.get('amount'));
      if (!name) { toast('Vul een omschrijving in'); form.name.focus(); return; }
      if (isNaN(amount) || amount < 0) { toast('Vul een geldig bedrag in'); form.amount.focus(); return; }
      const kind = f.get('kind'); const status = f.get('status');
      let dateV = clampDateToMonth(f.get('date'), ym);
      const doc = materialize(ym);
      const idx = doc.transactions.findIndex(x => x.id === t.id);
      const n = idx >= 0 ? doc.transactions[idx] : { id: t.id };
      n.name = name; n.kind = kind; n.accountId = f.get('accountId');
      if (kind === 'transfer') n.toAccountId = f.get('toAccountId'); else delete n.toAccountId;
      if (kind === 'transfer' && n.toAccountId === n.accountId) { toast('Kies twee verschillende rekeningen'); return; }
      n.category = String(f.get('category') || '').trim(); n.note = String(f.get('note') || '').trim();
      n.day = dateV ? Number(dateV.slice(8, 10)) : (n.day == null ? null : n.day);
      n.status = status;
      if (status === 'confirmed') { n.actualAmount = round2(amount); n.actualDate = dateV; if (!n.recurringId) n.amount = round2(amount); if (n.amount == null) n.amount = round2(amount); }
      else { n.amount = round2(amount); n.actualAmount = null; n.actualDate = null; }
      if (n.recurringId) n.edited = true;
      if (isNew && f.get('repeat')) {
        const rid = uid('rec');
        const tpl = { name, kind, accountId: n.accountId, amount: round2(amount), day: n.day, category: n.category, active: true, from: ym, until: null, note: '' };
        if (kind === 'transfer') tpl.toAccountId = n.toAccountId;
        Store.set('recurring', rid, tpl); n.recurringId = rid; n.edited = true;
      }
      if (idx >= 0) doc.transactions[idx] = n; else doc.transactions.push(n);
      saveMonth(ym, doc); closeDialog(); toast(isNew ? 'Post toegevoegd' : 'Post opgeslagen');
    });
    const del = $('[data-act=dlg-delete]', d);
    if (del) del.addEventListener('click', () => {
      const doc = materialize(ym);
      doc.transactions = doc.transactions.filter(x => x.id !== t.id);
      if (t.recurringId) { doc.dismissed = doc.dismissed || []; if (!doc.dismissed.includes(t.recurringId)) doc.dismissed.push(t.recurringId); }
      saveMonth(ym, doc); closeDialog(); toast(isRec ? 'Weggelaten voor deze maand' : 'Post verwijderd');
    });
  });
}

/* ---------- confirm ---------- */
function confirmDialog(ym, t) {
  const c = ymCmp(ym, todayYM());
  let date = t.day != null ? ym + '-' + pad2(Math.min(t.day, daysInMonth(ym))) : defaultDate(ym);
  if (c === 0 && (t.day == null || t.day > todayDay())) date = todayISO();
  const body = `<div class="hint">Verwacht: <b class="num">${esc(money(t.amount))}</b>${t.day != null ? ` rond de ${esc(ordDay(t.day))}` : ''} · ${acctPill(t)}</div>
    <div class="row2">${field('Werkelijk bedrag', amountInput('amount', t.amount, 'required'))}${field('Datum', `<input name="date" type="date" value="${esc(date)}" min="${ym}-01" max="${ym}-${pad2(daysInMonth(ym))}">`)}</div>`;
  const foot = `<button type="button" class="btn ghost" data-act="dlg-skip">Deze maand overslaan</button><span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Bevestigen</button>`;
  openDialog(dlgShell(t.name, esc(monthLabel(ym)), body, foot), (d) => {
    const form = $('form', d);
    form.amount.select();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = parseAmount(form.amount.value);
      if (isNaN(amount) || amount < 0) { toast('Vul een geldig bedrag in'); return; }
      const doc = materialize(ym); const n = doc.transactions.find(x => x.id === t.id); if (!n) { closeDialog(); return; }
      n.status = 'confirmed'; n.actualAmount = round2(amount); n.actualDate = clampDateToMonth(form.date.value, ym) || date;
      saveMonth(ym, doc); closeDialog(); toast('Bevestigd');
    });
    $('[data-act=dlg-skip]', d).addEventListener('click', () => {
      const doc = materialize(ym); const n = doc.transactions.find(x => x.id === t.id); if (n) { n.status = 'skipped'; n.edited = true; }
      saveMonth(ym, doc); closeDialog(); toast('Overgeslagen voor deze maand');
    });
  });
}
function confirmAllDue(ym) {
  const doc = materialize(ym); let n = 0;
  for (const t of doc.transactions) if (isDue(t, ym)) { t.status = 'confirmed'; t.actualAmount = round2(t.amount); t.actualDate = ym + '-' + pad2(Math.min(t.day || 1, daysInMonth(ym))); n++; }
  if (n) { saveMonth(ym, doc); toast(`${n} post${n === 1 ? '' : 'en'} bevestigd`); }
}
function unskip(ym, id) {
  const doc = materialize(ym); const t = doc.transactions.find(x => x.id === id); if (!t) return;
  t.status = 'expected'; saveMonth(ym, doc); toast('Teruggezet naar verwacht');
}

/* ---------- opening balances ---------- */
function openingDialog(ym) {
  const M = monthCalc(ym);
  const isFirst = ym === firstYM();
  let rows = '';
  for (const a of accounts()) rows += `<span class="acct-pill" style="--acc-color:${esc(a.color)}"><span class="dot"></span>${esc(a.name)}</span><div class="amount-prefix"><input name="o_${esc(a.id)}" type="text" inputmode="decimal" value="${esc(fmtInput(M.opening[a.id] || 0))}"></div>`;
  const body = `<div class="hint">${M.hasOpeningOverride ? 'Deze beginsaldo’s zijn handmatig vastgezet.' : isFirst ? 'Dit is je eerste maand; deze saldo’s zijn het startpunt.' : 'Nu automatisch overgenomen uit het eindsaldo van ' + esc(monthLabel(ymAdd(ym, -1))) + '. Vul je werkelijke banksaldo’s in om af te stemmen.'}</div><div class="opening-grid">${rows}</div>`;
  const foot = `${M.hasOpeningOverride && !isFirst ? `<button type="button" class="btn ghost" data-act="dlg-auto">Weer automatisch</button>` : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Vastzetten</button>`;
  openDialog(dlgShell('Beginsaldo’s ' + monthLabel(ym), '1e van de maand', body, foot), (d) => {
    const form = $('form', d);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const doc = materialize(ym); const o = {};
      for (const a of accounts()) { const v = parseAmount(form['o_' + a.id].value); if (isNaN(v)) { toast('Ongeldig bedrag bij ' + a.name); return; } o[a.id] = round2(v); }
      doc.opening = o; saveMonth(ym, doc); closeDialog(); toast('Beginsaldo’s vastgezet');
    });
    const auto = $('[data-act=dlg-auto]', d);
    if (auto) auto.addEventListener('click', () => { const doc = materialize(ym); delete doc.opening; saveMonth(ym, doc); closeDialog(); toast('Beginsaldo’s volgen weer de vorige maand'); });
  });
}

/* ---------- recurring template ---------- */
function templateDialog(id) {
  const isNew = !id; const accs = accounts();
  const t = id ? clone(S.recurring[id]) : { name: '', kind: 'expense', accountId: accs[0].id, toAccountId: (accs[1] || accs[0]).id, amount: '', day: '', category: '', note: '', active: true, from: todayYM(), until: null };
  const body = `
    ${field('Omschrijving', `<input name="name" type="text" value="${esc(t.name)}" required placeholder="Bijv. Zorgverzekering">`)}
    ${field('Soort', segment('kind', [['expense', 'Uitgave'], ['income', 'Inkomst'], ['transfer', 'Overboeking']], t.kind))}
    <div class="row2">${field(t.kind === 'transfer' ? 'Van rekening' : 'Rekening', accountSelect('accountId', t.accountId))}
      <div id="to-wrap" class="${t.kind === 'transfer' ? '' : 'hidden'}">${field('Naar rekening', accountSelect('toAccountId', t.toAccountId))}</div></div>
    <div class="row2">${field('Bedrag per maand', amountInput('amount', t.amount, 'required'))}
      ${field('Dag van de maand', `<input name="day" type="number" min="1" max="31" value="${t.day == null ? '' : esc(t.day)}" placeholder="?">`, 'Leeg = dag onbekend; telt dan pas mee na bevestigen')}</div>
    <div class="row2">${field('Categorie', `<input name="category" type="text" list="cats" value="${esc(t.category || '')}">${catList()}`, '', true)}
      ${field('Notitie', `<input name="note" type="text" value="${esc(t.note || '')}" placeholder="bijv. 10e–15e">`, '', true)}</div>
    <div class="row2">${field('Vanaf', `<input name="from" type="month" value="${esc(t.from || '')}">`, '', true)}${field('Tot en met', `<input name="until" type="month" value="${esc(t.until || '')}">`, 'Leeg = loopt door', true)}</div>
    <label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Actief</label>`;
  const foot = `${!isNew ? `<button type="button" class="btn ghost danger" data-act="dlg-delete">Verwijderen</button>` : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Opslaan</button>`;
  openDialog(dlgShell(isNew ? 'Vaste last toevoegen' : 'Vaste last bewerken', '', body, foot), (d) => {
    wireSegments(d, (n, v) => { if (n === 'kind') $('#to-wrap', d).classList.toggle('hidden', v !== 'transfer'); });
    const form = $('form', d);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(form); const name = String(f.get('name') || '').trim(); const amount = parseAmount(f.get('amount'));
      if (!name) { toast('Vul een omschrijving in'); return; }
      if (isNaN(amount) || amount < 0) { toast('Vul een geldig bedrag in'); return; }
      const dayS = String(f.get('day') || '').trim(); const day = dayS ? Math.min(31, Math.max(1, Number(dayS))) : null;
      const n = { name, kind: f.get('kind'), accountId: f.get('accountId'), amount: round2(amount), day, category: String(f.get('category') || '').trim(), note: String(f.get('note') || '').trim(), active: !!f.get('active'), from: f.get('from') || null, until: f.get('until') || null };
      if (n.kind === 'transfer') { n.toAccountId = f.get('toAccountId'); if (n.toAccountId === n.accountId) { toast('Kies twee verschillende rekeningen'); return; } }
      Store.set('recurring', id || uid('rec'), n); closeDialog(); toast(isNew ? 'Vaste last toegevoegd' : 'Vaste last opgeslagen');
    });
    const del = $('[data-act=dlg-delete]', d);
    if (del) del.addEventListener('click', () => { Store.del('recurring', id); closeDialog(); toast('Vaste last verwijderd'); });
  });
}

/* ---------- loans ---------- */
function loanDialog(id) {
  const isNew = !id; const l = id ? clone(S.loans[id]) : { name: '', lender: '', original: '', balance: '', rate: '', monthly: '', endDate: '', note: '' };
  const body = `
    <div class="row2">${field('Naam', `<input name="name" type="text" value="${esc(l.name)}" required placeholder="Bijv. Hypotheek">`)}${field('Verstrekker', `<input name="lender" type="text" value="${esc(l.lender || '')}">`, '', true)}</div>
    <div class="row2">${field('Openstaand saldo', amountInput('balance', l.balance, 'required'))}${field('Oorspronkelijk bedrag', amountInput('original', l.original), '', true)}</div>
    <div class="row3">${field('Rente % per jaar', `<input name="rate" type="text" inputmode="decimal" value="${esc(l.rate == null ? '' : String(l.rate).replace('.', ','))}">`, '', true)}${field('Per maand', amountInput('monthly', l.monthly), '', true)}${field('Einddatum', `<input name="endDate" type="date" value="${esc(l.endDate || '')}">`, '', true)}</div>
    ${field('Notitie', `<input name="note" type="text" value="${esc(l.note || '')}">`, '', true)}`;
  const foot = `${!isNew ? `<button type="button" class="btn ghost danger" data-act="dlg-delete">Verwijderen</button>` : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Opslaan</button>`;
  openDialog(dlgShell(isNew ? 'Lening toevoegen' : 'Lening bewerken', '', body, foot), (d) => {
    const form = $('form', d);
    form.addEventListener('submit', (e) => {
      e.preventDefault(); const f = new FormData(form);
      const name = String(f.get('name') || '').trim(); const balance = parseAmount(f.get('balance'));
      if (!name) { toast('Vul een naam in'); return; } if (isNaN(balance)) { toast('Vul het openstaande saldo in'); return; }
      const num = (k) => { const v = parseAmount(f.get(k)); return isNaN(v) ? null : round2(v); };
      const n = { name, lender: String(f.get('lender') || '').trim(), balance: round2(balance), original: num('original'), rate: num('rate'), monthly: num('monthly'), endDate: f.get('endDate') || null, note: String(f.get('note') || '').trim(), updated: todayISO() };
      Store.set('loans', id || uid('loan'), n); closeDialog(); toast(isNew ? 'Lening toegevoegd' : 'Lening opgeslagen');
    });
    const del = $('[data-act=dlg-delete]', d);
    if (del) del.addEventListener('click', () => { Store.del('loans', id); closeDialog(); toast('Lening verwijderd'); });
  });
}

/* ---------- assets ---------- */
function assetDialog(type, id) {
  const isNew = !id; const a = id ? clone(S.assets[id]) : { type, name: '', value: '', woz: '', invested: '', platform: '', loanId: '', date: todayISO(), note: '' };
  type = a.type || type;
  const meta = ASSET_META[type];
  let body = `<div class="row2">${field('Naam', `<input name="name" type="text" value="${esc(a.name)}" required placeholder="${type === 'house' ? 'Bijv. Woning IJmuiden' : type === 'investment' ? 'Bijv. DEGIRO portefeuille' : 'Bijv. Auto'}">`)}${field('Peildatum', `<input name="date" type="date" value="${esc(a.date || todayISO())}">`)}</div>`;
  if (type === 'house') {
    const loans = Object.entries(S.loans);
    body += `<div class="row2">${field('Geschatte marktwaarde', amountInput('value', a.value, 'required'))}${field('WOZ-waarde', amountInput('woz', a.woz), '', true)}</div>
      ${field('Gekoppelde hypotheek', `<select name="loanId"><option value="">— geen —</option>${loans.map(([lid, l]) => `<option value="${esc(lid)}" ${lid === a.loanId ? 'selected' : ''}>${esc(l.name)} (${esc(money(l.balance))})</option>`).join('')}</select>`, loans.length ? 'Voor de berekening van de overwaarde' : 'Voeg eerst een lening toe onder Leningen', true)}`;
  } else if (type === 'investment') {
    body += `<div class="row2">${field('Huidige waarde', amountInput('value', a.value, 'required'))}${field('Totale inleg', amountInput('invested', a.invested), '', true)}</div>${field('Platform / broker', `<input name="platform" type="text" value="${esc(a.platform || '')}">`, '', true)}`;
  } else {
    body += field('Huidige waarde', amountInput('value', a.value, 'required'));
  }
  body += field('Notitie', `<input name="note" type="text" value="${esc(a.note || '')}">`, '', true);
  if (!isNew && a.history && a.history.length > 1) body += `<div class="hint">Waardeverloop: ${a.history.slice(-6).map(x => `${esc(dateLabel(x.date))} ${esc(money(x.value))}`).join(' → ')}</div>`;
  const foot = `${!isNew ? `<button type="button" class="btn ghost danger" data-act="dlg-delete">Verwijderen</button>` : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Opslaan</button>`;
  openDialog(dlgShell(isNew ? meta.title + ' toevoegen' : meta.title + ' bewerken', '', body, foot), (d) => {
    const form = $('form', d);
    form.addEventListener('submit', (e) => {
      e.preventDefault(); const f = new FormData(form);
      const name = String(f.get('name') || '').trim(); const value = parseAmount(f.get('value'));
      if (!name) { toast('Vul een naam in'); return; } if (isNaN(value)) { toast('Vul de waarde in'); return; }
      const num = (k) => { const v = parseAmount(f.get(k)); return isNaN(v) ? null : round2(v); };
      const date = f.get('date') || todayISO();
      const n = { type, name, value: round2(value), date, note: String(f.get('note') || '').trim(), history: (a.history || []).slice() };
      if (type === 'house') { n.woz = num('woz'); n.loanId = f.get('loanId') || null; }
      if (type === 'investment') { n.invested = num('invested'); n.platform = String(f.get('platform') || '').trim(); }
      const last = n.history[n.history.length - 1];
      if (!last || Math.abs(Number(last.value) - n.value) > 0.004 || last.date !== date) { n.history = n.history.filter(x => x.date !== date); n.history.push({ date, value: n.value }); n.history.sort((x, y) => x.date.localeCompare(y.date)); if (n.history.length > 60) n.history = n.history.slice(-60); }
      Store.set('assets', id || uid('as'), n); closeDialog(); toast(isNew ? 'Toegevoegd' : 'Opgeslagen');
    });
    const del = $('[data-act=dlg-delete]', d);
    if (del) del.addEventListener('click', () => { Store.del('assets', id); closeDialog(); toast('Verwijderd'); });
  });
}

/* ---------- accounts ---------- */
function ensureConfig() { if (!S.config) S.config = { accounts: [], currency: 'EUR', locale: 'nl-NL', firstMonth: todayYM(), version: 1 }; return clone(S.config); }
function slug(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rek'; }
function accountDialog(id) {
  const cfg = ensureConfig(); const isNew = !id;
  const a = id ? clone(cfg.accounts.find(x => x.id === id)) : { name: '', short: '', color: PALETTE[cfg.accounts.length % PALETTE.length], iban: '', archived: false };
  const body = `
    <div class="row2">${field('Naam', `<input name="name" type="text" value="${esc(a.name)}" required placeholder="Bijv. ING Betaalrekening">`)}${field('Korte naam', `<input name="short" type="text" value="${esc(a.short || '')}" maxlength="12" placeholder="Bijv. ING">`, 'Voor smalle kolommen', true)}</div>
    ${field('Rekeningnummer', `<input name="iban" type="text" value="${esc(a.iban || '')}" placeholder="NL00 BANK 0000 0000 00">`, 'Alleen ter herkenning', true)}
    ${field('Kleur', `<input type="hidden" name="color" value="${esc(a.color)}"><div class="color-row">${PALETTE.map(c => `<button type="button" data-c="${c}" style="background:${c}" aria-pressed="${c === a.color}" aria-label="${c}"></button>`).join('')}</div>`)}
    ${!isNew ? `<label class="check"><input type="checkbox" name="archived" ${a.archived ? 'checked' : ''}> Archiveren (verbergen, geschiedenis blijft bewaard)</label>` : ''}`;
  const foot = `<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">Opslaan</button>`;
  openDialog(dlgShell(isNew ? 'Rekening toevoegen' : 'Rekening bewerken', '', body, foot), (d) => {
    const form = $('form', d);
    $('.color-row', d).addEventListener('click', (e) => { const b = e.target.closest('button[data-c]'); if (!b) return; $$('.color-row button', d).forEach(x => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); form.color.value = b.dataset.c; });
    form.addEventListener('submit', (e) => {
      e.preventDefault(); const f = new FormData(form); const name = String(f.get('name') || '').trim();
      if (!name) { toast('Vul een naam in'); return; }
      const c = ensureConfig();
      if (isNew) {
        let nid = slug(name), k = 2; while (c.accounts.some(x => x.id === nid)) nid = slug(name) + '-' + (k++);
        c.accounts.push({ id: nid, name, short: String(f.get('short') || '').trim() || name.slice(0, 12), color: f.get('color'), iban: String(f.get('iban') || '').trim(), order: c.accounts.length + 1 });
      } else {
        const x = c.accounts.find(x => x.id === id); x.name = name; x.short = String(f.get('short') || '').trim() || name.slice(0, 12); x.color = f.get('color'); x.iban = String(f.get('iban') || '').trim(); x.archived = !!f.get('archived');
      }
      Store.set('config', 'main', c); closeDialog(); toast(isNew ? 'Rekening toegevoegd' : 'Rekening opgeslagen');
    });
  });
}
function moveAccount(id, dir) {
  const c = ensureConfig(); const list = c.accounts.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const i = list.findIndex(a => a.id === id); const j = i + dir; if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]]; list.forEach((a, k) => { a.order = k + 1; }); c.accounts = list; Store.set('config', 'main', c);
}

/* ================= events ================= */
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab'); if (tab) { S.view.tab = tab.dataset.tab; render(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id, ym = S.view.ym;
  const findTx = (tid) => monthCalc(ym).txs.find(t => t.id === tid);
  switch (act) {
    case 'close': closeDialog(); break;
    case 'prev': S.view.ym = ymAdd(ym, -1); render(); break;
    case 'next': S.view.ym = ymAdd(ym, 1); render(); break;
    case 'today': S.view.ym = todayYM(); render(); break;
    case 'goto': S.view.ym = b.dataset.ym; S.view.tab = 'maand'; render(); break;
    case 'go-settings': S.view.tab = 'instellingen'; render(); break;
    case 'filter': S.view.accountFilter = S.view.accountFilter === id ? null : id; render(); break;
    case 'add': txDialog(ym, null); break;
    case 'edit': { const t = findTx(id); if (t) txDialog(ym, t); break; }
    case 'confirm': { const t = findTx(id); if (t) confirmDialog(ym, t); break; }
    case 'confirm-all': confirmAllDue(ym); break;
    case 'unskip': unskip(ym, id); break;
    case 'opening': openingDialog(ym); break;
    case 'add-tpl': templateDialog(null); break;
    case 'edit-tpl': templateDialog(id); break;
    case 'add-loan': loanDialog(null); break;
    case 'edit-loan': loanDialog(id); break;
    case 'add-asset': assetDialog(b.dataset.type, null); break;
    case 'edit-asset': assetDialog(null, id); break;
    case 'add-acct': accountDialog(null); break;
    case 'edit-acct': accountDialog(id); break;
    case 'acct-up': moveAccount(id, -1); break;
    case 'acct-down': moveAccount(id, 1); break;
  }
});
document.addEventListener('change', (e) => {
  const sw = e.target.closest('[data-act=toggle-tpl]'); if (!sw) return;
  const t = clone(S.recurring[sw.dataset.id]); if (!t) return; t.active = sw.checked; Store.set('recurring', sw.dataset.id, t);
  toast(t.active ? 'Vaste last actief' : 'Vaste last uitgeschakeld');
});
$('#dlg').addEventListener('close', () => { $('#dlg').innerHTML = ''; });
$('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) closeDialog(); });

/* ================= shell: login screen, settings extras, import/export, service worker ================= */
function renderShell() {
  const needLogin = S.backend === 'supabase' && !S.user;
  $('#screen-login').hidden = !needLogin;
  $('#app-header').hidden = needLogin;
  $('#app-main').hidden = needLogin;
  if (needLogin) { $('#loading').classList.add('hidden'); return; }
  setSync();
  render();
}

/* ---- login form ---- */
function loginMsg(text, kind) { const m = $('#login-msg'); m.textContent = text || ''; m.className = 'login-msg ' + (kind || ''); }
async function withBusy(btn, fn) { btn.disabled = true; try { await fn(); } catch (e) { loginMsg(friendlyAuthError(e), 'err'); } finally { btn.disabled = false; } }
function friendlyAuthError(e) {
  const m = String(e && e.message || e || '');
  if (/Invalid login credentials/i.test(m)) return 'Onjuist e-mailadres of wachtwoord.';
  if (/Email not confirmed/i.test(m)) return 'Bevestig eerst je e-mailadres via de link in je mail.';
  if (/User already registered/i.test(m)) return 'Er bestaat al een account met dit e-mailadres — log in.';
  if (/Password should be/i.test(m)) return 'Wachtwoord moet minimaal 6 tekens zijn.';
  if (/Signups not allowed/i.test(m)) return 'Nieuwe accounts zijn uitgeschakeld in Supabase.';
  if (/rate limit/i.test(m)) return 'Even wachten — te veel pogingen achter elkaar.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Geen verbinding met Supabase. Controleer je internet en config.js.';
  return m || 'Er ging iets mis.';
}
(function wireLogin() {
  const form = $('#login-form'); if (!form) return;
  const email = () => form.email.value.trim(); const pw = () => form.password.value;
  $('#btn-login').addEventListener('click', (e) => { e.preventDefault(); if (!email() || !pw()) return loginMsg('Vul e-mailadres en wachtwoord in.', 'err'); withBusy(e.target, async () => { await Store.signIn(email(), pw()); loginMsg(''); }); });
  $('#btn-signup').addEventListener('click', (e) => { e.preventDefault(); if (!email() || !pw()) return loginMsg('Vul e-mailadres en een wachtwoord (min. 6 tekens) in.', 'err'); withBusy(e.target, async () => { const ok = await Store.signUp(email(), pw()); loginMsg(ok ? 'Account aangemaakt.' : 'Account aangemaakt — bevestig je e-mailadres via de link in je mail en log daarna in.', 'ok'); }); });
  $('#btn-reset').addEventListener('click', (e) => { e.preventDefault(); if (!email()) return loginMsg('Vul eerst je e-mailadres in.', 'err'); withBusy(e.target, async () => { await Store.resetPassword(email()); loginMsg('We hebben je een e-mail gestuurd met een link om een nieuw wachtwoord te kiezen.', 'ok'); }); });
  form.addEventListener('submit', (e) => { e.preventDefault(); $('#btn-login').click(); });
})();

function newPasswordDialog() {
  const body = field('Nieuw wachtwoord', `<input name="pw" type="password" minlength="6" required autocomplete="new-password">`, 'Minimaal 6 tekens');
  const foot = `<span class="spacer"></span><button type="button" class="btn" data-act="close">Later</button><button type="submit" class="btn primary">Opslaan</button>`;
  openDialog(dlgShell('Nieuw wachtwoord kiezen', '', body, foot), (d) => {
    const form = $('form', d);
    form.addEventListener('submit', async (e) => { e.preventDefault(); try { await Store.updatePassword(form.pw.value); closeDialog(); toast('Wachtwoord gewijzigd'); } catch (err) { toast(friendlyAuthError(err)); } });
  });
}

/* ---- settings panel extras (account, sync, import/export) ---- */
function settingsExtraHtml() {
  const isEmpty = !S.config || !(S.config.accounts || []).length;
  let h = `<div class="card" style="margin-top:16px;padding:14px 16px"><div class="settings-grid">`;
  if (S.backend === 'supabase') {
    h += `<div><div class="l">Account</div><div class="v">${esc(S.user && S.user.email || '')}</div><div class="s">Gegevens gesynchroniseerd via Supabase</div></div>
      <div class="acts"><button class="btn sm" data-act="sync-now">Nu synchroniseren</button><button class="btn sm ghost" data-act="change-pw">Wachtwoord wijzigen</button><button class="btn sm ghost danger" data-act="logout">Uitloggen</button></div>`;
  } else {
    h += `<div><div class="l">Opslag</div><div class="v">Alleen dit apparaat</div><div class="s">Koppel Supabase via config.js om te synchroniseren (zie README)</div></div><div></div>`;
  }
  h += `<div><div class="l">Back-up</div><div class="v">Exporteren &amp; importeren</div><div class="s">Een JSON-bestand met al je rekeningen, vaste lasten, maanden, leningen en bezittingen</div></div>
    <div class="acts"><button class="btn sm" data-act="export">Exporteren</button><label class="btn sm">Importeren<input type="file" accept="application/json,.json" id="import-file" hidden></label></div>`;
  h += `<div><div class="l">Startgegevens</div><div class="v">Kasboek-snapshot van 3 september 2026</div><div class="s">De 6 rekeningen, 30 vaste lasten en augustus 2026 zoals ingericht in Claude${isEmpty ? '' : ' — overschrijft gelijknamige gegevens'}</div></div>
    <div class="acts"><button class="btn sm ${isEmpty ? 'primary' : ''}" data-act="seed">Startgegevens laden</button></div>`;
  h += `</div></div>`;
  return h;
}

function exportJson() {
  const data = { exported: new Date().toISOString(), config: S.config, recurring: S.recurring, months: S.months, loans: S.loans, assets: S.assets };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kasboek-backup-${todayISO()}.json`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Back-up gedownload');
}
function bundleToWrites(d) {
  const w = [];
  if (d.config) w.push({ coll: 'config', id: 'main', doc: d.config });
  for (const c of ['recurring', 'months', 'loans', 'assets']) for (const [id, doc] of Object.entries(d[c] || {})) w.push({ coll: c, id, doc });
  return w;
}
function confirmDlg(title, text, okLabel) {
  return new Promise((resolve) => {
    const foot = `<span class="spacer"></span><button type="button" class="btn" data-act="close">Annuleren</button><button type="submit" class="btn primary">${esc(okLabel || 'Doorgaan')}</button>`;
    openDialog(dlgShell(title, '', `<p class="dlg-text">${esc(text)}</p>`, foot), (d) => {
      let done = false;
      $('form', d).addEventListener('submit', (e) => { e.preventDefault(); done = true; closeDialog(); resolve(true); });
      $('#dlg').addEventListener('close', () => { if (!done) resolve(false); }, { once: true });
    });
  });
}
async function importBundle(d, label) {
  if (!d || typeof d !== 'object' || (!d.config && !d.recurring && !d.months)) { toast('Dit bestand is geen Kasboek-back-up'); return; }
  const w = bundleToWrites(d);
  if (!w.length) { toast('Geen gegevens gevonden'); return; }
  const ok = await confirmDlg(label, `${w.length} onderdelen laden? Bestaande gegevens met dezelfde naam worden overschreven.`, 'Laden');
  if (!ok) return;
  Store.setMany(w); toast(`${w.length} onderdelen geladen`);
}
async function loadSeed() {
  try { const r = await fetch('./seed.json', { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); importBundle(await r.json(), 'Startgegevens'); }
  catch (e) { toast('Startgegevens niet gevonden (seed.json)'); }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  switch (b.dataset.act) {
    case 'export': exportJson(); break;
    case 'seed': loadSeed(); break;
    case 'sync-now': Store.lastSync = null; Store.refresh(); toast('Synchroniseren…'); break;
    case 'logout': (async () => { if (Store.pending.length && !(await confirmDlg('Uitloggen', 'Er wachten nog wijzigingen op synchronisatie; die gaan verloren als je nu uitlogt.', 'Toch uitloggen'))) return; Store.signOut(); })(); break;
    case 'change-pw': newPasswordDialog(); break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'import-file') return;
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const rd = new FileReader(); rd.onload = () => { try { importBundle(JSON.parse(rd.result), 'Back-up ' + f.name); } catch (err) { toast('Bestand kon niet worden gelezen'); } e.target.value = ''; }; rd.readAsText(f);
});

/* ---- service worker + update notice ---- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            const n = $('#notice-update'); n.classList.remove('hidden');
            $('#btn-reload').onclick = () => location.reload();
          }
        });
      });
    }).catch(err => console.warn('sw', err));
  });
}
/* ================= boot ================= */
Store.init();
})();
