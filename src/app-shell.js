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
