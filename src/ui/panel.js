/* panel.js — the shared UI, v3.
 *
 * One view layer, four surfaces: an in-page drawer (shadow DOM, beside the
 * redeem form), a full-page app, a toolbar popup and the options page. The
 * surface only decides the shell; every view below is identical.
 *
 * Expects `root`, `DFRedeemCodes`, `DFRedeemGarena`, `DFRedeemEngine`,
 * `DFRedeemVault` and (optionally) `DF_REDEEM_SEED` in scope — the build step
 * inlines them above this file.
 *
 * Views: Dashboard | Library | Run | Presets | Share | History
 */

function createPanel(options) {
  const opts = options || {};
  const version = opts.version || '3.1.1';
  const surface = opts.surface || 'drawer'; // drawer | page | popup
  const store = opts.store || {
    get: (k, d) => { try { const v = localStorage.getItem('dfRedeem:' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set: (k, v) => { try { localStorage.setItem('dfRedeem:' + k, JSON.stringify(v)); } catch (_) {} },
    del: (k) => { try { localStorage.removeItem('dfRedeem:' + k); } catch (_) {} },
  };

  const E = root.DFRedeemEngine;
  const V = root.DFRedeemVault;
  const G = root.DFRedeemGarena;   /* verdict labels + verdict→vault status map */
  const S = root.DFRedeemSync;     /* community merge helper; absent in bare tests */

  /* 25, not 50: the drawer is ~515px wide and a 50-row page ran ~2000px tall,
   * which meant constant scrolling to reach the pager. Halving the page keeps a
   * page within a couple of screens at the default drawer height. */
  const PAGE_SIZE = 25;
  const VIEWS = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
  const VIEW_LABELS = {
    dashboard: 'Tổng quan', library: 'Kho code', run: 'Chạy đổi',
    presets: 'Preset Gunsmith', share: 'Chia sẻ', history: 'Lịch sử',
  };
  const VIEW_ICONS = {
    dashboard: '◈', library: '▤', run: '▶', presets: '⌖', share: '↗', history: '◷',
  };
  const VIEW_HINTS = {
    dashboard: 'Tình trạng toàn bộ kho code',
    library: 'Tìm, lọc, sửa trạng thái từng mã',
    run: 'Đổi hàng loạt trên trang Garena',
    presets: 'Preset Gunsmith cho mọi chế độ chơi',
    share: 'Xuất danh sách cho người khác',
    history: 'Mọi lần thử đã ghi lại',
  };
  const STATUS_LABELS = {
    untried: 'Chưa thử', success: 'Thành công', expired: 'Hết hạn',
    exhausted: 'Hết lượt', mine: 'Đã nhận', group_limit: 'Chạm giới hạn nhóm',
    sys_error: 'Garena lỗi', gift_bug: 'Lỗi quà',
    invalid: 'Không tồn tại',
  };
  const STATUS_ORDER = ['success', 'mine', 'group_limit', 'untried', 'sys_error', 'expired', 'exhausted', 'gift_bug', 'invalid'];
  const STATUS_HINT = {
    untried: 'Chưa gửi lên Garena lần nào.',
    success: 'Garena xác nhận đã nhận quà.',
    expired: 'Mã đã quá hạn sử dụng.',
    exhausted: 'Mã hết lượt đổi trên toàn hệ thống.',
    mine: 'Chính mã này đã được tài khoản của bạn đổi trước đó.',
    group_limit: 'Tài khoản bạn đã chạm giới hạn của nhóm quà này — mã vẫn còn tốt, người khác vẫn đổi được.',
    sys_error: 'Garena trả lỗi hệ thống, chưa kết luận được gì. Nên thử lại sau.',
    gift_bug: 'Garena nhận mã nhưng quà không vào — lỗi phía họ.',
    invalid: 'Garena trả về mã không tồn tại.',
  };
  const SHAREABLE = new Set(['success', 'expired', 'gift_bug']);

  /* vault may be injected (tests/mock) or built from the bundled class */
  const vault = opts.vault || (V ? new V.Vault({ adapter: new V.IndexedDBAdapter() }) : null);

  let activeRun = null;
  let view = store.get('view', 'dashboard');
  let libFilter = { status: 'all', q: '', sort: 'code' };
  /* Preset view has its own filter state: grouping by weapon class only
   * helps if you can also narrow to one class and search within it. */
  let presetFilter = { cls: 'all', q: '' };
  let libPage = 0;
  let selection = new Set();
  let cache = { codes: [], presets: [], stats: null, history: [], costs: {} };
  /* Costs this user has entered. Kept separate from `cache.costs` (the pulled
   * community record) so an unsynced edit survives a refresh and is visibly
   * "chờ gửi" rather than being silently replaced by the cloud value. */
  let costLocal = {};
  /* Which card is in cost-edit mode, plus its in-flight text and last error.
   * Only one card edits at a time: a grid of open inputs is how you get a user
   * typing a number into the wrong preset. */
  let costEdit = { code: null, value: '', error: '' };
  let historyCode = null;
  let paletteOpen = false;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtAgo = (ts) => {
    if (!ts) return '';
    const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'vừa xong';
    if (s < 3600) return Math.round(s / 60) + ' phút trước';
    if (s < 86400) return Math.round(s / 3600) + ' giờ trước';
    return Math.round(s / 86400) + ' ngày trước';
  };
  const fmtDur = (ms) => {
    if (!ms) return '0s';
    const s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'p' + String(s % 60).padStart(2, '0');
  };

  /* ── shell ─────────────────────────────────────────────────────────────── */
  const host = document.createElement('div');
  host.id = 'df-redeem-host';
  const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  const sheet = document.createElement('style');
  sheet.textContent = (typeof DF_THEME_CSS === 'string' ? DF_THEME_CSS : '') +
    (typeof DF_PANEL_CSS === 'string' ? DF_PANEL_CSS : '');
  shadow.appendChild(sheet);

  const width0 = store.get('drawerWidth', 520);

  const shell = document.createElement('div');
  shell.className = 'df shell';
  shell.hidden = true;
  shell.style.cssText = '--w:' + width0 + 'px';
  shell.innerHTML = `
    <button class="grip" title="Kéo để đổi chiều rộng" aria-label="Đổi chiều rộng"></button>
    <div class="drawer" role="dialog" aria-label="Delta Force Auto Redeem">
      <header class="hd">
        <div class="brand">
          <div class="stencil">Delta Force</div>
          <h2>Auto Redeem <span class="ver">v${esc(version)}</span></h2>
        </div>
        <div class="hd-acts">
          <span class="sync-chip" hidden></span>
          <button class="ico palette-btn" data-act="palette" title="Lệnh nhanh (Ctrl+K)">⌘</button>
          <button class="ico" data-act="refresh" title="Tải lại dữ liệu">⟳</button>
          <button class="ico close" title="Thu gọn (Esc)">✕</button>
        </div>
      </header>
      <nav class="views" role="tablist">
        ${VIEWS.map((v) => `<button class="vtab" role="tab" data-view="${v}" title="${esc(VIEW_HINTS[v])}">
          <span class="vi">${VIEW_ICONS[v]}</span><span class="vl">${esc(VIEW_LABELS[v])}</span>
        </button>`).join('')}
      </nav>
      <main class="view-host"></main>
      <footer class="ft"></footer>
    </div>`;

  const launcher = document.createElement('div');
  launcher.className = 'df launcher-wrap';
  launcher.hidden = true;
  launcher.innerHTML = `<button class="launcher" title="Mở bảng đổi code (Alt+D)">
    <span class="dot"></span>AUTO REDEEM</button>`;

  const toasts = document.createElement('div');
  toasts.className = 'df toast-wrap';
  /* Toasts are the only feedback for a finished run, a copy, or a sync failure.
   * Without a live region a screen-reader user gets silence, so announce them
   * politely — 'assertive' would interrupt the run log mid-sentence. */
  toasts.setAttribute('role', 'status');
  toasts.setAttribute('aria-live', 'polite');

  const palette = document.createElement('div');
  palette.className = 'df palette-wrap';
  palette.hidden = true;
  palette.innerHTML = `<div class="palette">
      <input class="pq" placeholder="Gõ để tìm lệnh hoặc mã code…" aria-label="Lệnh nhanh">
      <div class="phits"></div>
      <div class="pfoot"><kbd>↑↓</kbd> chọn <kbd>Enter</kbd> chạy <kbd>Esc</kbd> đóng</div>
    </div>`;

  shadow.appendChild(shell);
  shadow.appendChild(launcher);
  shadow.appendChild(palette);
  shadow.appendChild(toasts);

  const $ = (sel) => shell.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(shell.querySelectorAll(sel));
  const viewHost = $('.view-host');
  const footer = $('.ft');

  /* Save a hand-measured cost: validate locally, keep it optimistically, then
   * push. A failed push is not a lost number — it stays local and visibly
   * "chờ gửi", so the user's measurement work is never thrown away by a network
   * blip. */
  async function saveCost(code) {
    /* Cost reporting is only meaningful in Operations. Do not let a stale cloned
     * button, automation, or the programmatic panel API create a Warfare cost. */
    const preset = cache.presets.find((row) => String(row.code).toUpperCase() === String(code).toUpperCase());
    if (!preset || !costEligible(preset)) {
      return toast('Chi phí chỉ áp dụng cho preset Chiến Dịch (Thoát Hiểm).', 'warn');
    }
    const input = $('.pc-costedit .costin');
    const raw = input ? input.value : costEdit.value;
    const parsed = Costs.parseCost(raw);
    if (!parsed.ok) {
      costEdit = { code, value: String(raw || ''), error: parsed.error };
      return renderPresets();
    }

    const key = costKey(preset);
    costLocal[key] = { value: parsed.value, state: 'unconfirmed', pending: true };
    costEdit = { code: null, value: '', error: '' };
    renderPresets();
    await persistLocalCosts();

    if (!(opts.sync && opts.sync.reportCost)) {
      toast(`Đã lưu chi phí ${Costs.formatCost(parsed.value)} (chỉ trên máy này).`, 'ok');
      return undefined;
    }

    const reply = await opts.sync.reportCost(String(code).toUpperCase(), parsed.value, COST_MODE);
    if (!reply || !reply.ok) {
      if (reply && reply.skipped) {
        toast(`Đã lưu ${Costs.formatCost(parsed.value)} trên máy này — chưa bật kho chung nên không gửi lên được.`, 'warn');
      } else {
        toast(`Đã lưu trên máy này, gửi lên kho chung lỗi: ${(reply && reply.error) || 'không rõ'}`, 'warn');
      }
      return renderPresets();
    }

    /* The broker is authoritative about the agreed value and state, so adopt its
     * answer rather than keeping our own optimistic guess. */
    costLocal[key] = { value: reply.cost || parsed.value, state: reply.state, pending: false };
    cache.costs[key] = { value: reply.cost || parsed.value, state: reply.state, reports: reply.reports };
    await persistLocalCosts();
    const label = (Costs.STATES[reply.state] && Costs.STATES[reply.state].label) || reply.state;
    if (reply.state === 'disputed') {
      toast(`Số của bạn khác số đang có — đã chuyển sang chờ phê duyệt. Đang hiển thị ${Costs.formatCost(reply.cost)}.`, 'warn');
    } else if (reply.unchanged) {
      toast(`Chi phí ${Costs.formatCost(reply.cost)} đã có sẵn, không cần gửi lại.`, 'ok');
    } else {
      toast(`Đã gửi ${Costs.formatCost(reply.cost)} lên kho chung · ${label}.`, 'ok');
    }
    return renderPresets();
  }

  /* Local costs live in the sync service's own key-value store when available so
   * they survive a reload; a panel without a sync service still works, it just
   * forgets on refresh rather than failing. */
  async function persistLocalCosts() {
    try {
      if (opts.sync && opts.sync.setLocal) await opts.sync.setLocal('costsLocal', costLocal);
    } catch (_) { /* storage full or unavailable: keep the in-memory copy */ }
  }

  async function loadLocalCosts() {
    try {
      if (opts.sync && opts.sync.getLocal) {
        const stored = await opts.sync.getLocal('costsLocal');
        if (stored && typeof stored === 'object') costLocal = stored;
      }
    } catch (_) { /* unreadable store: start empty */ }
  }

  function toast(msg, tone) {
    const t = document.createElement('div');
    t.className = 'toast' + (tone ? ' ' + tone : '');
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(() => { try { toasts.removeChild(t); } catch (_) {} }, 4200);
  }

  /* ── data ──────────────────────────────────────────────────────────────── */
  /* Gift rows and preset rows share one store, told apart by `kind`. The seed
   * writes 'giftcode'; presets() joins in the weapon/mode half. */
  async function refresh() {
    if (!vault) return;
    const [all, presets, stats, hist] = await Promise.all([
      vault.all(), vault.presets(), vault.stats(), vault.history(),
    ]);
    const presetCodes = new Set(presets.map((r) => r.code));
    cache.codes = all.filter((r) => !presetCodes.has(r.code));
    cache.presets = presets;
    cache.stats = stats;
    cache.history = hist;

    /* IndexedDB is per-origin, so a run done in the Garena drawer is absent
     * from this store when we are the extension page (and vice versa). Merge
     * the shared mirror in, newest first, so History is complete on every
     * surface. De-duplicated on code+timestamp against the local rows. */
    if (opts.sync && opts.sync.readMirror) {
      try {
        const reply = await opts.sync.readMirror();
        const rows = (reply && reply.rows) || [];
        if (rows.length) {
          const seen = new Set(hist.map((r) => String(r.code).toUpperCase() + '|' + (r.timestamp || '')));
          const extra = rows.filter((r) => r && r.code
            && !seen.has(String(r.code).toUpperCase() + '|' + (r.timestamp || '')));
          cache.history = hist.concat(extra)
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
        }
      } catch (_) { /* the worker may be asleep; local history still renders */ }
    }
  }

  const shareableCodes = () => cache.codes.filter((r) => SHAREABLE.has(r.status));
  const untriedCodes = () => cache.codes.filter((r) => r.status === 'untried');

  /* The community contract has two one-way rules: remote dead-code verdicts may
   * mark a local untried code as dead, while this installation only publishes
   * verdicts that are true for every account. A local `mine` row is therefore
   * never sent and is never overwritten by someone else's public outcome. */
  async function syncCommunityVault(options) {
    const cfg = options || {};
    if (!vault || !opts.sync) return { pulled: null, pushed: null };
    let pulled = null;
    let pushed = null;
    if (cfg.pull !== false && opts.sync.communityPull && S && S.mergeCommunityCodes) {
      try {
        const reply = await opts.sync.communityPull();
        if (reply && reply.ok) {
          const merged = S.mergeCommunityCodes(await vault.all(), reply.codes || []);
          for (const row of merged.changedRecords || []) await vault.upsert(row);
          pulled = merged;
          await refresh();
        }
      } catch (_) { /* Offline community sync must never block redemption. */ }
    }
    if (cfg.push && opts.sync.communityPush) {
      try { pushed = await opts.sync.communityPush(await vault.all()); } catch (_) { /* keep local result */ }
    }
    /* Pull agreed costs alongside the codes. Failure is silent for the same
     * reason the code pull is: a broker that is down must not make the preset
     * list look broken, it just means costs show as "—" until it recovers. */
    if (cfg.pull !== false && opts.sync.fetchCosts) {
      try {
        const reply = await opts.sync.fetchCosts();
        if (reply && reply.ok) {
          cache.costs = reply.costs || {};
          /* A local pending value that the broker now agrees with is no longer
           * pending — drop it so the card stops showing "chờ gửi" forever. */
          for (const [code, remote] of Object.entries(cache.costs)) {
            const mine = costLocal[code];
            if (mine && Costs.agrees && Costs.agrees(mine.value, remote.value)) delete costLocal[code];
          }
          await persistLocalCosts();
        }
      } catch (_) { /* offline: keep whatever costs we already have */ }
    }
    return { pulled, pushed };
  }

  /* ── dashboard ─────────────────────────────────────────────────────────── */
  function renderDashboard() {
    const s = cache.stats || { total: 0, byStatus: {} };
    const by = s.byStatus || {};
    const total = cache.codes.length || 1;
    const share = shareableCodes().length;
    const untried = untriedCodes().length;

    const recent = cache.codes
      .filter((r) => r.last_attempt)
      .sort((a, b) => new Date(b.last_attempt) - new Date(a.last_attempt))
      .slice(0, 6);

    const bars = STATUS_ORDER.map((k) => {
      const n = by[k] || 0;
      const pct = Math.round((n / total) * 1000) / 10;
      return `<div class="bar-row" title="${esc(STATUS_HINT[k] || '')}">
        <span class="bl">${esc(STATUS_LABELS[k])}</span>
        <span class="bt"><i class="s-${k}" style="width:${pct}%"></i></span>
        <span class="bn">${n}</span>
      </div>`;
    }).join('');

    viewHost.innerHTML = `<div class="pad">
      <section class="kpis">
        <div class="kpi ok"><b>${by.success || 0}</b><span>Thành công</span></div>
        <div class="kpi share"><b>${share}</b><span>Chia sẻ được</span></div>
        <div class="kpi warn"><b>${untried}</b><span>Chưa thử</span></div>
        <div class="kpi preset"><b>${cache.presets.length}</b><span>Preset Gunsmith</span></div>
      </section>

      ${untried > 0
        ? `<div class="cta">
             <div><b>${untried} mã chưa thử.</b> Mở tab Chạy đổi để gửi lên Garena.</div>
             <button class="act primary" data-act="goto-run">Chạy ngay →</button>
           </div>`
        : `<div class="cta done">
             <div><b>Hết mã chưa thử.</b> Mọi gift code trong kho đã có kết quả từ Garena.</div>
             <button class="act" data-act="goto-share">Xuất danh sách →</button>
           </div>`}

      <section class="card">
        <div class="card-hd"><h3>Phân bố trạng thái</h3><span class="muted">${cache.codes.length} gift code</span></div>
        <div class="bars">${bars}</div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Hoạt động gần đây</h3>
          ${recent.length ? '<button class="act tiny" data-act="goto-history">Xem tất cả</button>' : ''}</div>
        ${recent.length ? `<ul class="feed">${recent.map((r) => `
          <li><span class="dot s-${r.status}"></span>
            <code class="mono">${esc(r.code)}</code>
            <span class="pill s-${r.status}">${esc(STATUS_LABELS[r.status] || r.status)}</span>
            <span class="muted ago">${esc(fmtAgo(r.last_attempt))}</span>
          </li>`).join('')}</ul>`
          : `<div class="empty"><div class="ei">◷</div>
               <p>Chưa có lần thử nào được ghi lại.</p>
               <span>Chạy một lượt ở tab Chạy đổi để lịch sử có dữ liệu.</span></div>`}
      </section>

      <section class="card">
        <div class="card-hd"><h3>Hai loại mã, hai cách dùng</h3></div>
        <div class="two">
          <div class="note">
            <b>Gift code</b>
            <p>Đổi trên web tại redeem.df.garena.sg. Tab <b>Chạy đổi</b> làm việc này.</p>
          </div>
          <div class="note">
            <b>Preset Gunsmith</b>
            <p>Dán trong game: Gunsmith → Loadout → nút kính lúp. Không đổi qua web được.</p>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* ── library ───────────────────────────────────────────────────────────── */
  function filteredCodes() {
    const q = libFilter.q.trim().toUpperCase();
    let rows = cache.codes.filter((r) => {
      if (libFilter.status !== 'all' && r.status !== libFilter.status) return false;
      if (q && !String(r.code).toUpperCase().includes(q)) return false;
      return true;
    });
    const dir = libFilter.sort === 'recent' ? -1 : 1;
    rows.sort((a, b) => {
      if (libFilter.sort === 'recent') {
        return dir * (new Date(a.last_attempt || 0) - new Date(b.last_attempt || 0));
      }
      if (libFilter.sort === 'status') return String(a.status).localeCompare(String(b.status)) || String(a.code).localeCompare(String(b.code));
      return String(a.code).localeCompare(String(b.code));
    });
    return rows;
  }

  function renderLibrary() {
    const rows = filteredCodes();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (libPage >= pages) libPage = pages - 1;
    const page = rows.slice(libPage * PAGE_SIZE, (libPage + 1) * PAGE_SIZE);

    const chips = ['all'].concat(STATUS_ORDER).map((k) => {
      const n = k === 'all' ? cache.codes.length : ((cache.stats && cache.stats.byStatus && cache.stats.byStatus[k]) || 0);
      const on = libFilter.status === k ? ' on' : '';
      const label = k === 'all' ? 'Tất cả' : STATUS_LABELS[k];
      return `<button class="chip${on}" data-act="fchip" data-k="${k}" aria-pressed="${libFilter.status === k}">
        ${k !== 'all' ? `<i class="s-${k}"></i>` : ''}${esc(label)} <b>${n}</b></button>`;
    }).join('');

    viewHost.innerHTML = `<div class="pad">
      <div class="filters two">
        <input class="fq" placeholder="Tìm mã…" value="${esc(libFilter.q)}" aria-label="Tìm mã">
        <select class="fsort" aria-label="Sắp xếp">
          <option value="code"${libFilter.sort === 'code' ? ' selected' : ''}>A→Z</option>
          <option value="recent"${libFilter.sort === 'recent' ? ' selected' : ''}>Mới thử</option>
          <option value="status"${libFilter.sort === 'status' ? ' selected' : ''}>Trạng thái</option>
        </select>
        ${libFilter.q || libFilter.status !== 'all' ? '<button class="act tiny ghost" data-act="fclear">Xoá lọc</button>' : ''}
      </div>

      <div class="chiprow" role="group" aria-label="Lọc theo trạng thái">${chips}</div>

      <div class="rescount muted" aria-live="polite">
        ${rows.length === cache.codes.length
          ? `${cache.codes.length} mã`
          : `${rows.length} / ${cache.codes.length} mã khớp`}
      </div>

      <div class="bulk ${selection.size ? '' : 'off'}">
        <b>${selection.size} mã đã chọn</b>
        <span class="spacer"></span>
        <button class="act tiny" data-act="bulk-copy">Copy</button>
        <button class="act tiny" data-act="bulk-queue">Đưa vào hàng chờ</button>
        <button class="act tiny ghost" data-act="bulk-clear">Bỏ chọn</button>
      </div>

      ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th class="cbx"><input type="checkbox" class="pick-all" aria-label="Chọn cả trang"></th>
          <th>Mã</th><th>Trạng thái</th><th>Lần thử</th><th></th>
        </tr></thead>
        <tbody>${page.map((r) => `<tr data-code="${esc(r.code)}">
          <td class="cbx"><input type="checkbox" class="pick"${selection.has(r.code) ? ' checked' : ''} aria-label="Chọn ${esc(r.code)}"></td>
          <td><code class="mono">${esc(r.code)}</code></td>
          <td><span class="pill s-${r.status}">${esc(STATUS_LABELS[r.status] || r.status)}</span></td>
          <td class="num">${r.attempt_count || 0}<span class="muted sub">${esc(fmtTime(r.last_attempt))}</span></td>
          <td class="rowacts">
            <button class="ico tiny" data-act="row-copy" data-code="${esc(r.code)}" title="Copy mã">⧉</button>
            <button class="ico tiny" data-act="row-hist" data-code="${esc(r.code)}" title="Lịch sử mã này">◷</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>

      <div class="pager">
        <button class="act tiny" data-act="pg-prev"${libPage === 0 ? ' disabled' : ''}>← Trước</button>
        <span>Trang ${libPage + 1}/${pages} · ${rows.length} mã</span>
        <button class="act tiny" data-act="pg-next"${libPage >= pages - 1 ? ' disabled' : ''}>Sau →</button>
      </div>`
      : `<div class="empty"><div class="ei">▤</div>
           <p>Không có mã nào khớp.</p>
           <span>Đổi bộ lọc hoặc xoá từ khoá tìm kiếm.</span>
           <button class="act tiny" data-act="fclear">Xoá bộ lọc</button></div>`}
    </div>`;
  }

  /* ── run ───────────────────────────────────────────────────────────────── */
  function renderRun() {
    const untried = untriedCodes();
    const retryable = cache.codes.filter((r) => r.status === 'sys_error');
    const onPage = onRedeemPage();
    const queued = store.get('queue', '');

    viewHost.innerHTML = `<div class="pad">
      ${onPage ? '' : `<div class="warn-box run-blocker" role="alert">
        <span class="warn-mark" aria-hidden="true">!</span>
        <div><b>Chưa thể chạy đổi code ở tab này</b>
        <p>Mở <code class="mono">redeem.df.garena.sg/vi/cdkgarena.html</code>, đăng nhập Garena, rồi chạy lại tại đó. Nút Bắt đầu đã được khoá để tránh báo lỗi sai cho cả hàng chờ.</p>
        <button class="act tiny warn-cta" data-act="open-redeem">Mở trang đổi code →</button></div>
      </div>`}

      <section class="card">
        <div class="card-hd"><h3>Hàng chờ</h3><span class="muted qcount">0 mã</span></div>
        <div class="runbar">
          <div class="runstat">
            <button class="act tiny" data-act="q-untried">Mã chưa thử (${untried.length})</button>
            ${retryable.length ? `<button class="act tiny" data-act="q-sys-error">Garena lỗi — thử lại (${retryable.length})</button>` : ''}
            <button class="act tiny" data-act="q-clear">Xoá hàng chờ</button>
          </div>
          <textarea class="queue" rows="7" placeholder="Mỗi dòng một mã. Dán từ bất kỳ đâu — ký tự lạ sẽ được lọc.">${esc(queued)}</textarea>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Nhịp gửi</h3><span class="muted">Chậm hơn = ít bị chặn hơn</span></div>
        <div class="pacerow">
          <label class="fld"><span>Giãn cách (ms)</span>
            <input class="pace" type="number" min="400" step="100" value="1200"></label>
          <label class="fld"><span>Thử lại tối đa</span>
            <input class="retries" type="number" min="0" max="5" value="2"></label>
          <label class="check"><input type="checkbox" class="variants" checked>
            <span>Dò biến thể OCR</span></label>
        </div>
      </section>

      <div class="runline">
        <button class="act primary go" data-act="start"${onPage ? '' : ' disabled title="Cần mở tại trang đổi code của Garena"'}>Bắt đầu</button>
        <button class="act" data-act="pause" disabled>Tạm dừng</button>
        <button class="act danger" data-act="stop" disabled>Dừng</button>
      </div>

      <section class="card prog-card" hidden>
        <div class="card-hd"><h3>Đang chạy</h3><span class="muted prog-eta"></span></div>
        <div class="prog"><i></i></div>
        <div class="prog-txt muted">Chuẩn bị…</div>
        <div class="tally"></div>
        <pre class="log"></pre>
      </section>
    </div>`;
    updateQueueCount();
  }

  function updateQueueCount() {
    const q = $('.queue');
    const label = $('.qcount');
    if (!q || !label) return;
    const n = parseQueue(q.value).length;
    label.textContent = n + ' mã';
  }

  function parseQueue(text) {
    const C = root.DFRedeemCodes;
    if (C && C.parseCodes) return C.parseCodes(text).codes.map((row) => row.code);
    /* Keep the submitted spelling: some legacy Garena codes are case-sensitive.
     * Deduplication happens in the parser with an uppercase canonical key. */
    const seen = new Set();
    return String(text || '').split(/[^A-Za-z0-9]+/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 6 && !seen.has(value.toUpperCase()) && (seen.add(value.toUpperCase()), true));
  }

  /* Redemption only works on the Garena page: every request from elsewhere
   * fails at the network layer. The view already warns about this, but the
   * Start button stayed enabled, so the warning read as advisory and clicking
   * Start produced a wall of failures that looked like dead codes rather than
   * a wrong-page mistake. Gate the control itself, and keep the guard in
   * startRun() too since the engine is also reachable via the programmatic
   * API at the bottom of this module. */
  const onRedeemPage = () => /redeem\.df\.garena\.sg$/.test(location.hostname || '');

  async function startRun() {
    if (activeRun) return toast('Đang có lượt chạy.', 'warn');
    if (!onRedeemPage()) return toast('Cần mở tab này tại trang đổi code của Garena.', 'warn');
    const codes = parseQueue($('.queue') ? $('.queue').value : '');
    if (!codes.length) return toast('Hàng chờ trống.', 'warn');
    if (!E) return toast('Thiếu engine.', 'err');

    const pace = Number(($('.pace') && $('.pace').value) || 1200);
    const retries = Number(($('.retries') && $('.retries').value) || 2);
    const variants = !$('.variants') || $('.variants').checked;

    store.set('queue', codes.join('\n'));

    const card = $('.prog-card');
    const bar = $('.prog i');
    const txt = $('.prog-txt');
    const eta = $('.prog-eta');
    const tally = $('.tally');
    const logEl = $('.log');
    if (card) card.hidden = false;
    if (logEl) logEl.textContent = '';

    $('[data-act="start"]').disabled = true;
    $('[data-act="pause"]').disabled = false;
    $('[data-act="stop"]').disabled = false;

    const counts = {};
    const t0 = Date.now();
    /* engine.js exports RedeemRun, and its constructor takes the queue as its
     * own first argument — not a config object with a `codes` key. Getting
     * either half wrong throws inside this async handler, which leaves the UI
     * frozen on "Chuẩn bị…" with nothing in the console, so construction is
     * guarded and any failure is surfaced and the controls released. */
    let run;
    try {
      run = new E.RedeemRun(
        codes.map((c) => ({ code: c, source: 'panel' })),
        { delayMs: pace, maxRetries: retries, tryVariants: variants },
      );
    } catch (e) {
      toast('Không khởi tạo được lượt chạy: ' + e.message, 'err');
      if (txt) txt.textContent = 'Lỗi khởi tạo: ' + e.message;
      const s = $('[data-act="start"]'); if (s) s.disabled = !onRedeemPage();
      const p = $('[data-act="pause"]'); if (p) p.disabled = true;
      const st = $('[data-act="stop"]'); if (st) st.disabled = true;
      return;
    }
    activeRun = run;

    /* Open a run row before the first attempt so every result carries a real
     * run_id and the History view can group attempts per run. Without this the
     * runs store stayed empty forever and each attempt logged run_id ''. */
    let runRow = null;
    if (vault && vault.createRun) {
      try {
        runRow = await vault.createRun({ total: codes.length, source: surface || 'panel' });
      } catch (_) { runRow = null; }
    }

    run.on('progress', (p) => {
      const pct = p.total ? Math.round((p.position / p.total) * 100) : 0;
      if (bar) bar.style.width = pct + '%';
      if (txt) txt.textContent = `${p.position}/${p.total} · ${p.code || ''} ${p.phase ? '· ' + p.phase : ''}`;
      if (eta && p.position > 1) {
        const per = (Date.now() - t0) / p.position;
        eta.textContent = 'còn ~' + fmtDur(per * (p.total - p.position));
      }
    });
    run.on('log', (l) => {
      if (!logEl) return;
      logEl.textContent = (l.message + '\n' + logEl.textContent).split('\n').slice(0, 80).join('\n');
    });
    run.on('result', async (r) => {
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (tally) {
        tally.innerHTML = Object.keys(counts).map((k) =>
          `<span class="pill">${esc(k)} <b>${counts[k]}</b></span>`).join('');
      }
      if (vault && vault.recordAttempt) {
        /* recordAttempt(codeValue, result, runId): the code is its own first
         * argument. Passing the whole result object made the code field an
         * object, which History then rendered as "[OBJECTOBJECT]".
         *
         * The verdict must also be translated into a vault status, or the write
         * falls through to the stored value and every attempt reads "Chưa thử".
         * A null mapping (throttling, captcha, network) intentionally leaves the
         * status untouched while still logging the attempt. */
        const mapped = G && G.vaultStatus ? G.vaultStatus(r.status) : null;
        try {
          await vault.recordAttempt(r.code, Object.assign({}, r, {
            status: mapped || undefined,
            result_msg: r.detail || r.label || '',
            err_code: r.errorCode,
          }), (runRow && runRow.id) || run.id || '');
          /* Mirror into shared storage so the other surfaces see this run. */
          if (opts.sync && opts.sync.mirrorAttempts) {
            opts.sync.mirrorAttempts([{
              code: r.code,
              status: mapped || 'untried',
              result_msg: r.detail || r.label || '',
              err_code: r.errorCode || null,
              timestamp: new Date().toISOString(),
              surface: surface || 'panel',
            }]).catch(() => {});
          }
        } catch (_) {}
      }
    });

    try {
      await run.run();
      const s = run.summary();
      toast(`Xong ${s.processed}/${s.total} mã · ${s.success} thành công.`, s.success ? 'ok' : '');
    } catch (e) {
      toast('Lượt chạy lỗi: ' + e.message, 'err');
    } finally {
      activeRun = null;
      /* Close the run row so History shows a finished run with its tally
       * instead of one that looks stuck in "running" forever. */
      if (runRow && vault && vault.finishRun) {
        const s = (() => { try { return run.summary(); } catch (_) { return {}; } })();
        try {
          await vault.finishRun(runRow.id, {
            status: 'done',
            total: s.total || codes.length,
            processed: s.processed || 0,
            success: s.success || 0,
          });
        } catch (_) {}
      }
      /* Keep the credential-backed personal cloud sync opt-in separate from the
       * public, credential-free community vault. It snapshots only after every
       * attempt is stored. */
      if (opts.sync && opts.sync.syncNow && vault && vault.all) {
        try {
          const settings = opts.sync.getSettings ? await opts.sync.getSettings() : null;
          if (!settings || (settings.enabled !== false && settings.autoSync !== false)) {
            const reply = await opts.sync.syncNow(await vault.all());
            const syncStatus = reply && reply.status ? reply.status : reply;
            if (syncStatus && syncStatus.state === 'error') toast('Đồng bộ cá nhân lỗi: ' + (syncStatus.error || 'không rõ'), 'err');
          }
        } catch (error) {
          toast('Đồng bộ cá nhân lỗi: ' + (error && error.message || error), 'err');
        }
      }
      /* Public community synchronization is credential-free and deliberately
       * separate: only globally meaningful verdicts are reported. */
      if (opts.sync && vault && vault.all) {
        const community = await syncCommunityVault({ pull: true, push: true });
        if (community.pushed && !community.pushed.ok && !community.pushed.skipped) {
          toast('Đồng bộ cộng đồng lỗi: ' + (community.pushed.error || 'không rõ'), 'err');
        }
      }
      const start = $('[data-act="start"]');
      if (start) start.disabled = !onRedeemPage();
      const p = $('[data-act="pause"]'); if (p) { p.disabled = true; p.textContent = 'Tạm dừng'; }
      const st = $('[data-act="stop"]'); if (st) st.disabled = true;
      await refresh();
    }
  }

  /* ── presets ───────────────────────────────────────────────────────────── */
  /* `mode` is community text collected in Vietnamese and English, so normalize
   * only proven aliases before grouping. Without this, one multiplayer mode is
   * shown as three separate sections and one Operations mode as two. Keep unknown
   * labels visible rather than guessing — they need a curator's decision. */
  const MODE_ALIASES = {
    'Havoc Warfare': 'Chiến Trường Toàn Diện',
    Warfare: 'Chiến Trường Toàn Diện',
    Operations: 'Chiến Dịch Sinh Tồn',
    'Chiến Dịch (Thoát Hiểm)': 'Chiến Dịch Sinh Tồn',
    /* Event/rotating Warfare playlists: the preset applies to the same
     * Warfare loadout, so they must not fragment into their own group. */
    'Tactical Turmoil': 'Chiến Trường Toàn Diện',
  };
  const canonicalMode = (mode) => MODE_ALIASES[String(mode || '').trim()] || String(mode || '').trim() || 'Khác';

  /* Weapon resolution lives in core so the catalogue is shared with the tests
   * and any other surface; fall back to a pass-through if the bundle predates
   * it, so an older cached core degrades to the previous behaviour rather than
   * throwing on render. */
  const Weapons = (typeof root !== 'undefined' && root.DFRedeemWeapons)
    || (typeof window !== 'undefined' && window.DFRedeemWeapons)
    || null;
  const classify = (p) => (Weapons
    ? Weapons.classifyPreset(p)
    : { cls: 'unknown', clsLabel: 'Chưa rõ loại súng', weapon: String((p && (p.weapon || p.gun)) || '—'), raw: '' });

  /* Same defensive lookup as Weapons: a missing costs module must degrade to
   * "no cost shown", never break the whole preset view. */
  const Costs = (typeof root !== 'undefined' && root.DFRedeemCosts)
    || (typeof window !== 'undefined' && window.DFRedeemCosts)
    || {
      formatCost: (v) => (v ? String(v) : '—'),
      parseCost: () => ({ ok: false, error: 'Không tải được module chi phí' }),
      STATES: {},
    };

  /* Cost belongs to one build in Hazard Operations (the Vietnamese client calls
   * it Chiến Dịch / Thoát Hiểm). The same gun can have many build codes, and
   * Warfare's free loadout has no meaningful purchase price. Key by the code,
   * not weapon name, then reject non-Operations reports at the Worker boundary
   * after the client sends the mode it displayed. */
  const COST_MODE = 'Chiến Dịch Sinh Tồn';
  const costEligible = (preset) => canonicalMode(preset && preset.mode) === COST_MODE;
  const costKey = (preset) => String((preset && preset.code) || '').toUpperCase();

  /* A preset's cost can come from three places, in order of authority:
   *   1. the community record pulled from the Worker (agreed by several users)
   *   2. the bundled data file (shipped with the build)
   *   3. a value this user typed but has not synced yet
   * The local unsynced value wins for display so editing feels immediate, with
   * its pending state visible rather than silently overwritten on next pull. */
  function costFor(preset) {
    const code = costKey(preset);
    const local = costLocal[code];
    const remote = (cache.costs && cache.costs[code]) || null;
    const bundled = preset && preset.cost
      ? { value: Number(preset.cost), state: String(preset.cost_state || 'unconfirmed') }
      : null;
    const pick = local || remote || bundled;
    if (!pick || !pick.value) return { value: 0, state: 'none', label: '', hint: '' };
    const meta = Costs.STATES && Costs.STATES[pick.state];
    return {
      value: Number(pick.value),
      state: pick.state,
      label: local && local.pending ? 'Chờ gửi' : (meta ? meta.label : ''),
      hint: local && local.pending ? 'Chưa gửi lên kho chung' : (meta ? meta.hint : ''),
    };
  }

  function renderPresets() {
    /* Resolve once, then filter: every row needs its class for both the chip
     * counts and the grouping, so classifying inside the loop would repeat the
     * catalogue scan for each. */
    const all = cache.presets.map((p) => ({ preset: p, meta: classify(p) }));

    const counts = new Map();
    for (const row of all) counts.set(row.meta.cls, (counts.get(row.meta.cls) || 0) + 1);

    const q = presetFilter.q.trim().toUpperCase();
    const rows = all.filter(({ preset, meta }) => {
      if (presetFilter.cls !== 'all' && meta.cls !== presetFilter.cls) return false;
      if (!q) return true;
      /* Search covers the code, the resolved name and whatever the submitter
       * typed, so pasting a code from Discord finds it and so does typing the
       * Vietnamese gun name. */
      return `${preset.code} ${meta.weapon} ${meta.raw} ${preset.mode || ''}`.toUpperCase().includes(q);
    });

    /* Section order follows the in-game Gunsmith class order, not the
     * alphabet, with unknowns last so dirty data never leads the page. */
    const order = (Weapons ? Weapons.WEAPON_CLASSES.map((c) => c.id) : []).concat(['unknown']);
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.meta.cls)) groups.set(row.meta.cls, []);
      groups.get(row.meta.cls).push(row);
    }
    const sections = order.filter((id) => groups.has(id)).map((id) => ({
      id,
      label: groups.get(id)[0].meta.clsLabel,
      rows: groups.get(id).slice().sort((a, b) => String(a.meta.weapon).localeCompare(String(b.meta.weapon))),
    }));

    const chipFor = (id, label, n) => `<button class="chip${presetFilter.cls === id ? ' on' : ''}"
      data-act="pchip" data-k="${esc(id)}"${presetFilter.cls === id ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${esc(label)} <b>${n}</b></button>`;

    const chips = [chipFor('all', 'Tất cả', all.length)].concat(
      order.filter((id) => counts.get(id)).map((id) => {
        const cls = Weapons && Weapons.WEAPON_CLASSES.find((c) => c.id === id);
        return chipFor(id, cls ? cls.label : 'Chưa rõ loại súng', counts.get(id));
      }),
    ).join('');

    viewHost.innerHTML = `<div class="pad">
      <div class="info-box">
        <b>Loại mã này nhập trong game, không đổi qua web.</b>
        <p>Gunsmith → Loadout → nút kính lúp → dán mã. Linh kiện chưa mở khoá sẽ không nạp được.</p>
      </div>

      <div class="filters two">
        <input class="pq" placeholder="Tìm mã, tên súng, chế độ…" value="${esc(presetFilter.q)}" aria-label="Tìm preset">
        ${presetFilter.q || presetFilter.cls !== 'all' ? '<button class="act tiny ghost" data-act="pclear">Xoá lọc</button>' : ''}
      </div>

      <div class="chiprow" role="group" aria-label="Lọc theo loại súng">${chips}</div>

      ${sections.length ? sections.map((s) => `<section class="card">
        <div class="card-hd"><h3>${esc(s.label)}</h3><span class="muted">${s.rows.length} mã</span></div>
        <div class="pgrid">${s.rows.map(({ preset, meta }) => {
          const cost = costFor(preset);
          const editing = costEdit.code === preset.code;
          return `<div class="pcard${cost.state === 'disputed' ? ' pc-disputed' : ''}">
          <div class="pc-hd">
            <b>${esc(meta.weapon)}</b>
            ${preset.verified ? '<span class="tag ok" title="Đã kiểm tra">✓</span>' : ''}
          </div>
          ${meta.raw ? `<div class="pc-raw muted" title="Người gửi ghi: ${esc(meta.raw)}">ghi: ${esc(meta.raw)}</div>` : ''}
          <code class="mono pc-code">${esc(preset.code)}</code>
          <div class="pc-meta">
            <span class="pc-mode">${esc(canonicalMode(preset.mode))}</span>
            ${preset.author && preset.author !== 'bundled' ? `<span class="muted pc-by">${esc(preset.author)}</span>` : ''}
          </div>

          ${editing ? `<div class="pc-costedit">
            <label class="fld"><span>Chi phí trang bị · Chiến Dịch</span>
              <input class="costin mono" inputmode="numeric" value="${esc(costEdit.value)}"
                placeholder="ví dụ 295426 hoặc 290K" aria-label="Chi phí trang bị"></label>
            <div class="btnrow tight">
              <button class="act tiny primary" data-act="cost-save" data-code="${esc(preset.code)}">Lưu</button>
              <button class="act tiny ghost" data-act="cost-cancel">Thôi</button>
            </div>
            <p class="muted tiny cost-hint">Chỉ áp cho build Chiến Dịch này. Số được đối chiếu theo mã build, không theo tên súng.</p>
            ${costEdit.error ? `<p class="bad tiny">${esc(costEdit.error)}</p>` : ''}
          </div>` : costEligible(preset) ? `<div class="pc-cost ${cost.value ? 'has' : 'none'}">
            <span class="pc-cost-label">Chi phí trang bị</span>
            <b class="pc-cost-val mono">${cost.value ? esc(Costs.formatCost(cost.value)) : '—'}</b>
            ${cost.value ? `<span class="cost-state cs-${esc(cost.state)}" title="${esc(cost.hint)}">${esc(cost.label)}</span>` : ''}
            <button class="act tiny ghost pc-cost-edit" data-act="cost-edit" data-code="${esc(preset.code)}"
              title="${cost.value ? 'Sửa chi phí build Chiến Dịch này' : 'Áp preset trong game rồi nhập chi phí Chiến Dịch'}">${cost.value ? 'Sửa' : '+ Thêm'}</button>
          </div>` : `<div class="pc-cost pc-cost-na" title="Chiến Trường Toàn Diện phát sẵn trang bị, nên build này không có chi phí">
            <span class="pc-cost-label">Chi phí trang bị</span><span class="muted pc-cost-na-text">Miễn phí ở chế độ này</span>
          </div>`}

          <div class="pc-ft">
            <button class="act tiny" data-act="row-copy" data-code="${esc(preset.code)}">Copy</button>
          </div>
        </div>`;
        }).join('')}</div>
      </section>`).join('')
      : `<div class="empty"><div class="ei">⌖</div><p>${all.length
        ? 'Không có preset nào khớp bộ lọc.'
        : 'Chưa có code súng nào.'}</p>${all.length
        ? '<button class="act tiny ghost" data-act="pclear">Xoá lọc</button>'
        : ''}</div>`}
    </div>`;

    const pq = viewHost.querySelector('.pq');
    if (pq) {
      pq.addEventListener('input', () => { presetFilter.q = pq.value; renderPresets(); });
      /* Re-focus after the re-render so typing is not interrupted. */
      if (presetFilter.q) {
        pq.focus();
        /* Guarded: setSelectionRange is absent on some input types and on
         * non-browser DOM stubs, and losing the caret must never break render. */
        if (typeof pq.setSelectionRange === 'function') {
          pq.setSelectionRange(pq.value.length, pq.value.length);
        }
      }
    }
  }

  /* ── share ─────────────────────────────────────────────────────────────── */
  function renderShare() {
    const gifts = shareableCodes();
    const presets = cache.presets;
    /* How much of the local vault came from the shared list, so the card says
     * something before any button is pressed rather than sitting blank. */
    const fromCommunity = cache.codes.filter((c) => (c.tags || []).includes('community')).length;

    viewHost.innerHTML = `<div class="pad">
      <section class="card">
        <div class="card-hd"><h3>Kho cộng đồng</h3><span class="muted community-count">${fromCommunity} mã từ cộng đồng</span></div>
        <p class="muted tight">Tải danh sách mã mọi người đã kiểm chứng về máy, và gửi kết quả của bạn lên để người khác khỏi thử lại mã đã chết. Chỉ gửi mã và mã lỗi Garena trả về — không gửi tài khoản, cookie hay thời điểm.</p>
        <div class="btnrow">
          <button class="act primary" data-act="community-pull">Tải mã mới về</button>
          <button class="act" data-act="community-push">Gửi kết quả của tôi</button>
        </div>
        <p class="muted tight community-status"></p>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Gift code chia sẻ được</h3><span class="muted">${gifts.length} mã</span></div>
        <p class="muted tight">Gồm mã Garena đã xác nhận thành công và mã tài khoản này đã nhận — người khác vẫn đổi được.</p>
        <div class="sharebox">
          <textarea class="share-gift" rows="7" readonly>${esc(gifts.map((r) => r.code).join('\n'))}</textarea>
          <div class="btnrow">
            <button class="act" data-act="share-copy-gift">Copy</button>
            <button class="act" data-act="share-txt-gift">Tải .txt</button>
            <button class="act" data-act="share-csv-gift">Tải .csv</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Preset Gunsmith</h3><span class="muted">${presets.length} mã</span></div>
        <p class="muted tight">Định dạng <code class="mono">Súng-Chế độ-Mã</code> để người nhận biết dán vào đâu.</p>
        <div class="sharebox">
          <textarea class="share-preset" rows="7" readonly>${esc(presets.map((r) => `${r.weapon || r.gun || '?'}-${r.mode || '?'}-${r.code}`).join('\n'))}</textarea>
          <div class="btnrow">
            <button class="act" data-act="share-copy-preset">Copy</button>
            <button class="act" data-act="share-txt-preset">Tải .txt</button>
            <button class="act" data-act="share-csv-preset">Tải .csv</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Gói đầy đủ</h3></div>
        <p class="muted tight">Một file Markdown gồm cả hai loại, kèm hướng dẫn dùng.</p>
        <button class="act primary" data-act="share-both">Tải .md đầy đủ</button>
      </section>
    </div>`;
  }

  /* ── history ───────────────────────────────────────────────────────────── */
  function renderHistory() {
    /* The results store is the only real record of attempts: one row per try,
     * newest first. Code rows carry the latest outcome, not the sequence. */
    const events = (cache.history || [])
      .filter((r) => !historyCode || String(r.code).toUpperCase() === String(historyCode).toUpperCase())
      .map((r) => ({
        code: r.code,
        status: r.status,
        at: r.timestamp,
        note: [r.result_msg, r.err_code ? '#' + r.err_code : '', r.variant_used].filter(Boolean).join(' · '),
      }))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

    viewHost.innerHTML = `<div class="pad">
      ${historyCode ? `<div class="bulk">
        <b>Đang xem: <code class="mono">${esc(historyCode)}</code></b>
        <span class="spacer"></span>
        <button class="act tiny" data-act="hist-all">Xem tất cả</button>
      </div>` : ''}

      ${events.length ? `<ol class="tline">${events.slice(0, 200).map((e) => `<li>
        <span class="dot s-${e.status}"></span>
        <div class="tl-body">
          <div class="tl-top">
            <code class="mono">${esc(e.code)}</code>
            <span class="pill s-${e.status}">${esc(STATUS_LABELS[e.status] || e.status)}</span>
          </div>
          <div class="muted">${esc(fmtTime(e.at))} · ${esc(fmtAgo(e.at))}${e.note ? ' · ' + esc(e.note) : ''}</div>
        </div>
      </li>`).join('')}</ol>`
      : `<div class="empty"><div class="ei">◷</div>
           <p>Chưa có lần thử nào được ghi lại.</p>
           <span>Lịch sử chỉ ghi các lượt chạy từ tab Chạy đổi. Mã đổi tay trên trang Garena không vào đây.</span>
           <button class="act tiny primary" data-act="goto-run">Mở tab Chạy đổi</button></div>`}
    </div>`;
  }

  /* ── router ────────────────────────────────────────────────────────────── */
  const RENDER = {
    dashboard: renderDashboard, library: renderLibrary, run: renderRun,
    presets: renderPresets, share: renderShare, history: renderHistory,
  };

  async function go(name) {
    if (!VIEWS.includes(name)) name = 'dashboard';
    view = name;
    store.set('view', name);
    $$('.vtab').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    await refresh();
    RENDER[name]();
    renderFooter();
    renderBadges();
  }

  function renderBadges() {
    const n = untriedCodes().length;
    $$('.vtab').forEach((b) => {
      const old = b.querySelector('.badge');
      if (old) b.removeChild(old);
      if (b.dataset.view === 'run' && n > 0) {
        const s = document.createElement('span');
        s.className = 'badge';
        s.textContent = String(n);
        b.appendChild(s);
      }
    });
  }

  function renderFooter() {
    const s = cache.stats || {};
    const sv = s.seedVersion != null ? s.seedVersion
      : (typeof DF_REDEEM_SEED !== 'undefined' && DF_REDEEM_SEED.version) || '?';
    footer.innerHTML = `<span>${cache.codes.length} gift · ${cache.presets.length} preset</span>
      <span class="spacer"></span>
      <span>seed v${esc(sv)}</span>
      <span class="kbd-hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>`;
  }

  /* ── command palette ───────────────────────────────────────────────────── */
  function paletteItems() {
    const items = VIEWS.map((v) => ({
      label: VIEW_LABELS[v], hint: VIEW_HINTS[v], icon: VIEW_ICONS[v],
      run: () => { historyCode = null; go(v); },
    }));
    items.push(
      { label: 'Tải lại dữ liệu', hint: 'Đọc lại từ kho', icon: '⟳', run: () => go(view) },
      { label: 'Đưa mã chưa thử vào hàng chờ', hint: untriedCodes().length + ' mã', icon: '▶',
        run: async () => { await go('run'); const q = $('.queue'); if (q) { q.value = untriedCodes().map((r) => r.code).join('\n'); updateQueueCount(); } } },
      { label: 'Copy danh sách chia sẻ', hint: shareableCodes().length + ' mã', icon: '⧉',
        run: () => copy(shareableCodes().map((r) => r.code).join('\n'), 'danh sách chia sẻ') },
      { label: 'Thu gọn bảng', hint: 'Esc', icon: '✕', run: closePanel },
    );
    return items;
  }

  function openPalette() {
    paletteOpen = true;
    palette.hidden = false;
    const q = palette.querySelector('.pq');
    q.value = '';
    fillPalette('');
    if (q.focus) q.focus();
  }
  function closePalette() { paletteOpen = false; palette.hidden = true; }

  function fillPalette(q) {
    const needle = String(q || '').trim().toUpperCase();
    const box = palette.querySelector('.phits');
    let hits = paletteItems().filter((i) => !needle || (i.label + ' ' + i.hint).toUpperCase().includes(needle));

    /* a query that looks like a code jumps straight to that code's history */
    if (needle.length >= 4) {
      const match = cache.codes.concat(cache.presets)
        .filter((r) => String(r.code).toUpperCase().includes(needle)).slice(0, 5);
      hits = match.map((r) => ({
        label: r.code, hint: STATUS_LABELS[r.status] || r.status, icon: '◷',
        run: () => { historyCode = r.code; go('history'); },
      })).concat(hits);
    }

    const top = hits.slice(0, 8);
    box.innerHTML = top.map((h, i) => `<button class="phit${i === 0 ? ' on' : ''}" data-i="${i}">
      <span class="pi">${h.icon}</span><b>${esc(h.label)}</b><span class="muted">${esc(h.hint)}</span></button>`).join('')
      || '<div class="pnone muted">Không có lệnh nào khớp.</div>';
    palette._hits = top;
  }

  palette.addEventListener('input', (e) => { if (e.target.classList.contains('pq')) fillPalette(e.target.value); });
  palette.addEventListener('click', (e) => {
    const hit = e.target.closest ? e.target.closest('.phit') : null;
    if (hit && palette._hits) { closePalette(); palette._hits[Number(hit.dataset.i)].run(); return; }
    if (e.target === palette) closePalette();
  });
  palette.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closePalette();
    const btns = Array.prototype.slice.call(palette.querySelectorAll('.phit'));
    const cur = btns.findIndex((b) => b.classList.contains('on'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.preventDefault) e.preventDefault();
      const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('on', i === next));
    }
    if (e.key === 'Enter' && palette._hits && palette._hits[cur]) {
      if (e.preventDefault) e.preventDefault();
      closePalette(); palette._hits[cur].run();
    }
  });

  /* ── helpers ───────────────────────────────────────────────────────────── */
  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Đã copy ' + (what || '') + '.', 'ok');
    } catch (_) { toast('Không copy được — chọn và Ctrl+C thủ công.', 'warn'); }
  }

  function download(name, body, mime) {
    try {
      const blob = new Blob([body], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); try { document.body.removeChild(a); } catch (_) {} }, 0);
      toast('Đã tải ' + name, 'ok');
    } catch (e) { toast('Không tải được: ' + e.message, 'err'); }
  }

  const csvOf = (rows, cols) => '\ufeff' + [cols.join(',')]
    .concat(rows.map((r) => cols.map((c) => `"${String(r[c] == null ? '' : r[c]).replace(/"/g, '""')}"`).join(',')))
    .join('\r\n');

  /* ── events ────────────────────────────────────────────────────────────── */
  shell.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('fq')) { libFilter.q = t.value; libPage = 0; renderLibrary(); }
    if (t.classList.contains('queue')) { store.set('queue', t.value); updateQueueCount(); }
  });

  shell.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('fsort')) { libFilter.sort = t.value; renderLibrary(); }
    if (t.classList.contains('pick')) {
      const tr = t.closest('tr');
      const code = tr && tr.dataset.code;
      if (code) { t.checked ? selection.add(code) : selection.delete(code); renderLibrary(); }
    }
    if (t.classList.contains('pick-all')) {
      const codes = $$('tbody tr').map((tr) => tr.dataset.code).filter(Boolean);
      codes.forEach((c) => (t.checked ? selection.add(c) : selection.delete(c)));
      renderLibrary();
    }
  });

  shell.addEventListener('click', async (e) => {
    const tab = e.target.closest ? e.target.closest('.vtab') : null;
    if (tab) { historyCode = null; return go(tab.dataset.view); }

    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'palette') return openPalette();
    if (act === 'refresh') { await go(view); return toast('Đã tải lại.', 'ok'); }
    if (act === 'goto-run') { historyCode = null; return go('run'); }
    if (act === 'goto-share') return go('share');
    if (act === 'goto-history') { historyCode = null; return go('history'); }
    if (act === 'hist-all') { historyCode = null; return go('history'); }
    if (act === 'open-redeem') { location.href = 'https://redeem.df.garena.sg/vi/cdkgarena.html'; return; }

    /* library */
    if (act === 'fchip') { libFilter.status = btn.dataset.k; libPage = 0; return renderLibrary(); }
    if (act === 'fclear') { libFilter = { status: 'all', q: '', sort: libFilter.sort }; libPage = 0; return renderLibrary(); }
    /* presets */
    if (act === 'pchip') {
      /* The full-page app replays a click from a cloned card back into this
       * shadow tree. Multiple chips share data-act, so code-only matching always
       * selected the FIRST chip ("Tất cả") and made every filter look dead.
       * Match its class key too, then render the same state the user clicked. */
      presetFilter.cls = btn.dataset.k || 'all';
      return renderPresets();
    }
    if (act === 'pclear') { presetFilter = { cls: 'all', q: '' }; return renderPresets(); }
    /* cost editing — one card at a time, see costEdit */
    if (act === 'cost-edit') {
      const code = btn.dataset.code;
      const current = costFor({ code, cost: 0 });
      costEdit = { code, value: current.value ? String(current.value) : '', error: '' };
      renderPresets();
      /* Focus after render so the user can type straight away; without this the
       * button keeps focus and the first keystroke goes nowhere. */
      const input = $('.pc-costedit .costin');
      if (input) { input.focus(); input.select(); }
      return undefined;
    }
    if (act === 'cost-cancel') { costEdit = { code: null, value: '', error: '' }; return renderPresets(); }
    if (act === 'cost-save') return saveCost(btn.dataset.code);
    if (act === 'pg-prev') { libPage = Math.max(0, libPage - 1); return renderLibrary(); }
    if (act === 'pg-next') { libPage += 1; return renderLibrary(); }
    if (act === 'row-copy') return copy(btn.dataset.code, 'mã ' + btn.dataset.code);
    if (act === 'row-hist') { historyCode = btn.dataset.code; return go('history'); }
    if (act === 'bulk-clear') { selection.clear(); return renderLibrary(); }
    if (act === 'bulk-copy') return copy([...selection].join('\n'), selection.size + ' mã');
    if (act === 'bulk-queue') {
      const picked = [...selection];
      await go('run');
      const q = $('.queue');
      if (q) { q.value = picked.join('\n'); store.set('queue', q.value); updateQueueCount(); }
      return toast(picked.length + ' mã đã vào hàng chờ.', 'ok');
    }

    /* run */
    if (act === 'q-untried') {
      const q = $('.queue');
      if (q) { q.value = untriedCodes().map((r) => r.code).join('\n'); store.set('queue', q.value); updateQueueCount(); }
      return;
    }
    if (act === 'q-clear') { const q = $('.queue'); if (q) { q.value = ''; store.del('queue'); updateQueueCount(); } return; }
    /* Error 51 rows are the ones Garena never gave a verdict for, so they are
     * the only group worth re-sending wholesale. */
    if (act === 'q-sys-error') {
      const q = $('.queue');
      const rows = cache.codes.filter((r) => r.status === 'sys_error');
      if (q) { q.value = rows.map((r) => r.code).join('\n'); store.set('queue', q.value); updateQueueCount(); }
      return toast(rows.length + ' mã lỗi hệ thống đã vào hàng chờ.', 'ok');
    }
    if (act === 'start') return startRun();
    if (act === 'pause') {
      if (!activeRun) return;
      if (activeRun.paused) { activeRun.resume(); btn.textContent = 'Tạm dừng'; }
      else { activeRun.pause(); btn.textContent = 'Tiếp tục'; }
      return;
    }
    if (act === 'stop') { if (activeRun) { activeRun.stop('Người dùng dừng.'); toast('Đang dừng…', 'warn'); } return; }

    /* community vault */
    if (act === 'community-pull') {
      if (!opts.sync || !opts.sync.communityPull) return toast('Bản này không có kho cộng đồng.', 'warn');
      const note = $('.community-status');
      if (note) note.textContent = 'Đang tải…';
      try {
        const synced = await syncCommunityVault({ pull: true, push: false });
        const merged = synced.pulled;
        if (!merged) throw new Error('không tải được');
        go('share');
        const msg = `Thêm ${merged.added} mã mới, cập nhật ${merged.updated} mã.`;
        toast(msg, 'ok');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      } catch (error) {
        const msg = 'Không tải được kho cộng đồng: ' + String(error && error.message || error);
        toast(msg, 'err');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      }
      return;
    }
    if (act === 'community-push') {
      if (!opts.sync || !opts.sync.communityPush) return toast('Bản này không có kho cộng đồng.', 'warn');
      const note = $('.community-status');
      if (note) note.textContent = 'Đang gửi…';
      try {
        const reply = await opts.sync.communityPush(cache.codes);
        if (!reply || !reply.ok) throw new Error((reply && reply.error) || (reply && reply.skipped) || 'không gửi được');
        const needed = Math.max(1, Number(reply.needed || 2));
        const msg = reply.sent
          ? `Đã gửi ${reply.sent} kết quả. Mã mới cần ${needed} người dùng độc lập xác nhận mới vào kho chung.`
          : 'Không có kết quả dùng chung để gửi — dữ liệu account chỉ giữ trên máy này.';
        toast(msg, 'ok');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      } catch (error) {
        const msg = 'Không gửi được: ' + String(error && error.message || error);
        toast(msg, 'err');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      }
      return;
    }

    /* share */
    if (act === 'share-copy-gift') return copy($('.share-gift').value, 'danh sách gift code');
    if (act === 'share-copy-preset') return copy($('.share-preset').value, 'danh sách preset');
    if (act === 'share-txt-gift') return download('gift-codes-chia-se.txt', $('.share-gift').value);
    if (act === 'share-txt-preset') return download('code-sung-op.txt', $('.share-preset').value);
    if (act === 'share-csv-gift') {
      return download('gift-codes-chia-se.csv',
        csvOf(shareableCodes(), ['code', 'status', 'source', 'attempt_count', 'last_attempt']),
        'text/csv;charset=utf-8');
    }
    if (act === 'share-csv-preset') {
      return download('code-sung-op.csv',
        csvOf(cache.presets, ['code', 'weapon', 'mode', 'format', 'source']),
        'text/csv;charset=utf-8');
    }
    if (act === 'share-both') {
      const md = [
        '# Code Delta Force chia sẻ', '',
        '## Gift code — đổi tại redeem.df.garena.sg/vi/cdkgarena.html', '',
        '```', $('.share-gift').value, '```', '',
        '## Preset Gunsmith — nhập trong game', '',
        'Gunsmith → Loadout → nút kính lúp → dán mã. Linh kiện chưa mở khoá sẽ không nạp được.', '',
        '```', $('.share-preset').value, '```', '',
      ].join('\n');
      return download('df-code-chia-se.md', md, 'text/markdown;charset=utf-8');
    }
  });

  /* ── drawer resize ─────────────────────────────────────────────────────── */
  (function resizable() {
    const grip = $('.grip');
    if (!grip || !grip.addEventListener) return;
    let dragging = false;
    grip.addEventListener('mousedown', (e) => {
      dragging = true; grip.classList.add('active');
      if (e.preventDefault) e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const w = Math.min(Math.max(vw - e.clientX, 380), Math.min(920, vw));
      shell.style.cssText = '--w:' + Math.round(w) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; grip.classList.remove('active');
      const w = parseInt(String(shell.style.cssText).replace(/\D/g, ''), 10);
      if (w) store.set('drawerWidth', w);
    });
  }());

  /* ── shell behaviour ───────────────────────────────────────────────────── */
  function mountHost() { if (!host.isConnected) document.documentElement.appendChild(host); }

  async function open() {
    mountHost();
    shell.hidden = false;
    launcher.hidden = true;
    if (vault && !vault._ready) {
      try {
        if (vault.init) await vault.init();
        if (vault.seedOnFirstRun && typeof DF_REDEEM_SEED !== 'undefined') await vault.seedOnFirstRun(DF_REDEEM_SEED);
        vault._ready = true;
      } catch (e) { toast('Không mở được kho dữ liệu: ' + e.message, 'err'); }
    }
    /* Local costs before the first paint, so a pending value the user typed last
     * session is on screen immediately instead of appearing after the pull. */
    await loadLocalCosts();
    await syncCommunityVault({ pull: true, push: false });
    await go(view);
  }
  function closePanel() { shell.hidden = true; launcher.hidden = false; }
  function mountLauncher() { mountHost(); launcher.hidden = false; }

  $('.close').addEventListener('click', closePanel);
  launcher.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      if (e.preventDefault) e.preventDefault();
      if (shell.hidden) open();
      return paletteOpen ? closePalette() : openPalette();
    }
    if (e.altKey && (e.key === 'd' || e.key === 'D')) {
      if (e.preventDefault) e.preventDefault();
      return shell.hidden ? open() : closePanel();
    }
    if (shell.hidden) return;
    if (e.key === 'Escape') return paletteOpen ? closePalette() : closePanel();
    if (e.altKey && /^[1-6]$/.test(e.key)) { historyCode = null; go(VIEWS[Number(e.key) - 1]); }
  });

  async function setSyncChip() {
    const chip = $('.sync-chip');
    if (!chip || !opts.sync || !opts.sync.status) { if (chip) chip.hidden = true; return; }
    try {
      const s = await opts.sync.status();
      const label = { ok: 'Đã đồng bộ', syncing: 'Đang đồng bộ…', error: 'Lỗi đồng bộ', 'never-synced': 'Chưa đồng bộ' }[s.state] || s.state;
      chip.hidden = false;
      chip.textContent = label;
      chip.className = 'sync-chip st-' + s.state;
    } catch (_) {}
  }
  setSyncChip();

  return {
    open, close: closePanel, mountLauncher, go, refresh,
    start: startRun,
    palette: openPalette,
    getStats: () => cache.stats,
    getResults: () => cache.codes.slice(),
    vault, surface,
    _host: host, _shadow: shadow, _views: VIEWS, _shell: shell,
  };
}
