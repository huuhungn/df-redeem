/* options.js — reads and writes sync settings through the service worker. */
(function dfRedeemOptions() {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ask = (op, payload) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op, payload });

  function flash(el, message, ok) {
    el.textContent = message;
    el.className = 'status ' + (ok ? 'ok' : 'err');
    setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function toggleRest() { $('rest-only').hidden = $('backend').value !== 'rest'; }

  function renderSyncStatus(status) {
    const state = $('sync-state');
    const last = $('sync-last');
    const count = $('sync-count');
    if (!state) return;
    const labels = { ok: 'Đã đồng bộ', syncing: 'Đang đồng bộ…', error: 'Lỗi đồng bộ', 'never-synced': 'Chưa đồng bộ' };
    const value = status && status.state || 'never-synced';
    state.textContent = labels[value] || value;
    state.className = value === 'error' ? 'err' : value === 'ok' ? 'ok' : '';
    last.textContent = status && status.lastSyncAt ? 'Lần cuối: ' + new Date(status.lastSyncAt).toLocaleString() : '';
    count.textContent = status && Number.isFinite(Number(status.recordCount)) ? String(status.recordCount) + ' mã' : '';
    if (value === 'error' && status.error) state.title = status.error;
    else state.removeAttribute('title');
  }

  async function refreshSyncStatus() {
    const status = await ask('status');
    renderSyncStatus(status || { state: 'never-synced' });
  }

  async function load() {
    const settings = (await ask('getSettings')) || {};
    $('enabled').checked = settings.enabled === true;
    $('backend').value = settings.backend || 'chrome-sync';
    $('endpoint').value = settings.endpoint || '';
    $('auto').checked = settings.autoSync !== false;
    /* hasToken is a boolean flag; the token itself never leaves the worker. */
    if (settings.hasToken) $('token').placeholder = '•••••• (đã lưu — để trống nếu không đổi)';
    toggleRest();
    await refreshSyncStatus();
  }

  $('backend').addEventListener('change', toggleRest);

  $('save').addEventListener('click', async () => {
    const payload = {
      enabled: $('enabled').checked,
      backend: $('backend').value,
      endpoint: $('endpoint').value.trim(),
      autoSync: $('auto').checked,
    };
    const token = $('token').value;
    if (token) payload.token = token;
    const res = await ask('setSettings', payload);
    $('token').value = '';
    flash($('status'), res && res.ok ? 'Đã lưu.' : 'Lỗi: ' + ((res && res.error) || 'không rõ'), res && res.ok);
    if (res && res.ok) load();
  });

  $('test').addEventListener('click', async () => {
    flash($('status'), 'Đang kiểm tra…', true);
    const res = await ask('test');
    flash($('status'), res && res.ok ? 'Kết nối tốt.' : 'Thất bại: ' + ((res && res.error) || 'không rõ'), res && res.ok);
    renderSyncStatus(res && res.status ? res.status : { state: 'error', error: res && res.error });
  });

  $('export').addEventListener('click', async () => {
    const res = await ask('export');
    if (!res || !res.ok) { flash($('status2'), 'Không xuất được.', false); return; }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads?.download?.({ url, filename: 'df-redeem-vault.json' }).catch(() => {});
    const a = document.createElement('a');
    a.href = url; a.download = 'df-redeem-vault.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    flash($('status2'), 'Đã xuất.', true);
  });

  $('wipe').addEventListener('click', async () => {
    if (!confirm(['Xoá bản sao lưu trên cloud và cài đặt đồng bộ?', '', 'Kho mã trong máy này KHÔNG bị xoá — bạn không mất mã nào.'].join(String.fromCharCode(10)))) return;
    const res = await ask('wipe');
    flash($('status2'), res && res.ok ? 'Đã xoá.' : 'Lỗi.', res && res.ok);
    load();
  });

  load();
}());
