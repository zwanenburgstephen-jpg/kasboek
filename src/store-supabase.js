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
