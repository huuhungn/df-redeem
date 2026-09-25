/* export-share.js — write the shareable lists to disk in every offered format.
 * Reads the live Share view, so what lands on disk is exactly what the UI
 * hands the user. */
'use strict';
const fs = require('fs');
const path = require('path');
const { attach } = require('./cdp');
const OUT = process.argv[2] || '.';
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";

(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  if (!t) throw new Error('open the redeem page first');
  const c = await attach(t.webSocketDebuggerUrl);
  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="share"]'); if (b) b.click(); })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const data = await c.evaluate(`(async () => {
    const sh = ${SH};
    const gift = (sh.querySelector('.share-gift') || {}).value || '';
    const preset = (sh.querySelector('.share-preset') || {}).value || '';
    /* The CSV buttons build their rows from the vault. The panel exposes its
     * vault handle, so read through that rather than re-deriving columns. */
    const p = window.__dfRedeemPanel;
    let rows = [], presets = [];
    if (p && p.vault && p.vault.all) {
      const all = await p.vault.all();
      rows = all.filter((r) => r.kind !== 'preset');
      presets = all.filter((r) => r.kind === 'preset');
    }
    return { gift, preset, rows, presets };
  })()`);

  fs.mkdirSync(OUT, { recursive: true });
  const codes = data.gift.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const presets = data.preset.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const w = (name, body) => { fs.writeFileSync(path.join(OUT, name), body, 'utf8'); console.log(name + '  ' + body.split('\n').length + ' lines'); };

  w('giftcodes.txt', codes.join('\r\n') + '\r\n');
  w('weapon-presets.txt', presets.join('\r\n') + '\r\n');

  const share = (data.rows || []).filter((r) => r.status === 'success' || r.status === 'mine');
  if (share.length) {
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const cols = ['code', 'status', 'source', 'attempt_count', 'last_tried'];
    w('giftcodes.csv', [cols.join(','), ...share.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\r\n') + '\r\n');
  }
  w('df-code-chia-se.md', [
    '# Code Delta Force chia sẻ', '',
    `Cập nhật: ${new Date().toLocaleString('vi-VN')} · ${codes.length} gift code · ${presets.length} code súng`, '',
    '## Gift code', '', 'Đổi tại https://redeem.df.garena.sg/vi/cdkgarena.html', '',
    '```', codes.join('\n'), '```', '',
    '## Code Súng OP', '',
    'Nhập trong game: Gunsmith → Loadout → nút kính lúp → dán mã.', '',
    '```', presets.join('\n'), '```', '',
  ].join('\n'));
  console.log('\n' + codes.length + ' gift codes, ' + presets.length + ' presets → ' + OUT);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
