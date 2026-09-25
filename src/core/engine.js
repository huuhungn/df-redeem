/* engine.js — the redeem runner.
 *
 * Design rules baked in:
 *  1. A result is only SUCCESS when the network body says code===0. Popups lie.
 *  2. Every attempt is correlated to its own request by attempt id + code match,
 *     so a slow response from code N never gets credited to code N+1.
 *  3. Rate limiting is adaptive: consecutive clean answers speed the run up,
 *     any throttle signal slows it down and backs off exponentially.
 *  4. State is journaled after every code so a crashed/closed tab can resume.
 *  5. OCR variants are only tried when Garena says the code does not exist.
 */

(function attachEngine(root) {
  const Codes = root.DFRedeemCodes || (typeof require === 'function' ? require('./codes.js') : null);
  const Garena = root.DFRedeemGarena || (typeof require === 'function' ? require('./garena.js') : null);

  const DEFAULTS = {
    delayMs: 2500,             // pause between codes
    minDelayMs: 1200,
    maxDelayMs: 20000,
    responseTimeoutMs: 6000,   // how long to wait for the network body
    submitConfirmMs: 600,      // how long to confirm a click created a request
    submitClickRetries: 1,
    retryDelayMs: 5000,
    maxRetries: 1,             // retries for retryable statuses
    maxVariants: 3,            // OCR variants per failed code
    tryVariants: true,
    speedUpAfter: 8,           // clean answers before shaving the delay
    speedUpStepMs: 200,
    slowDownFactor: 2,
    stopOnFatal: true,
    jitterMs: 400,
  };

  const SELECTORS = {
    input: ['.exc-input', 'input[type="text"]:not([readonly])'],
    button: ['.btn-exchange'],
    dialog: ['[role="dialog"]', '.dialog', '.pop', '.popup', '.modal', '.exc-dialog'],
    tip: ['#superTips', '.super-tips'],
    close: ['.close', '.btn-close', "a[href='javascript:void(0);']", "a[href='javascript:void(0)']"],
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = () => Date.now();

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = root.getComputedStyle ? root.getComputedStyle(el) : null;
    const rect = el.getBoundingClientRect();
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    return rect.width > 0 && rect.height > 0;
  }

  function pick(selectors, predicate) {
    for (const selector of selectors) {
      const found = Array.prototype.slice.call(document.querySelectorAll(selector));
      const hit = found.find((el) => (predicate ? predicate(el) : visible(el)));
      if (hit) return hit;
    }
    return null;
  }

  function findInput() {
    return pick(SELECTORS.input, (el) => visible(el) && !el.disabled && !el.readOnly) ||
      Array.prototype.slice.call(document.querySelectorAll('input'))
        .find((el) => visible(el) && !el.disabled && !el.readOnly) || null;
  }

  function findButton() {
    const direct = pick(SELECTORS.button);
    if (direct) return direct;
    return Array.prototype.slice.call(document.querySelectorAll('a,button'))
      .find((el) => visible(el) && /^(đổi|exchange|redeem)$/i.test((el.textContent || '').trim())) || null;
  }

  /** Native setter so framework-bound inputs actually register the change. */
  function setValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  }

  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: root };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch (_) { /* PointerEvent may be unavailable */ }
    el.click();
  }

  function readPageMessage() {
    const dialog = pick(SELECTORS.dialog);
    if (dialog) {
      const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return { source: 'dialog', text };
    }
    const tip = pick(SELECTORS.tip, (el) => Boolean(el));
    if (tip) {
      const text = (tip.innerText || tip.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return { source: 'tip', text };
    }
    return { source: '', text: '' };
  }

  function closeDialog() {
    const dialog = pick(SELECTORS.dialog);
    if (!dialog) return;
    const closer = pick(SELECTORS.close, (el) => dialog.contains(el) && visible(el)) ||
      Array.prototype.slice.call(dialog.querySelectorAll('a,button')).find(visible);
    if (closer) realClick(closer);
  }

  async function clearMessages() {
    for (const selector of SELECTORS.tip) {
      const tip = document.querySelector(selector);
      if (tip) tip.textContent = '';
    }
    closeDialog();
    await sleep(120);
    closeDialog();
    for (const selector of SELECTORS.tip) {
      const tip = document.querySelector(selector);
      if (tip) tip.textContent = '';
    }
  }

  /* ── Network interception ─────────────────────────────────────────────── */

  function createNetworkTap(codeMatcher) {
    const bodies = [];
    const starts = [];
    let active = null;
    let restored = false;

    const originalFetch = root.fetch ? root.fetch.bind(root) : null;
    const originalOpen = root.XMLHttpRequest ? root.XMLHttpRequest.prototype.open : null;
    const originalSend = root.XMLHttpRequest ? root.XMLHttpRequest.prototype.send : null;

    const scan = (payload, depth, activeCode) => {
      if (payload == null || (depth || 0) > 3) return '';
      const match = (text) => codeMatcher(text, activeCode);
      if (typeof URLSearchParams !== 'undefined' && payload instanceof URLSearchParams) return match(payload.toString());
      if (typeof FormData !== 'undefined' && payload instanceof FormData) {
        return match(Array.from(payload.entries()).map(([k, v]) => `${k}=${v}`).join('&'));
      }
      if (typeof Request !== 'undefined' && payload instanceof Request) return match(payload.url);
      if (Array.isArray(payload)) {
        for (const item of payload) {
          const hit = scan(item, (depth || 0) + 1, activeCode);
          if (hit) return hit;
        }
        return '';
      }
      if (typeof payload === 'object') {
        try { return match(JSON.stringify(payload)); } catch (_) { return ''; }
      }
      return match(String(payload));
    };

    const recordStart = (attemptId, code, url) => {
      if (attemptId && code) starts.push({ time: now(), attemptId, code, url: url || '' });
    };
    const recordBody = (body, attemptId, code, httpStatus) => {
      if (!attemptId || !code) return;
      if (!Garena.looksLikeRedeemBody(body)) return;
      bodies.push({ time: now(), body, attemptId, code, httpStatus: httpStatus || 0 });
    };

    if (originalFetch) {
      root.fetch = async function tappedFetch(...args) {
        const attempt = active ? { id: active.id, code: active.code } : null;
        const code = scan(args, 0, attempt && attempt.code);
        recordStart(attempt && attempt.id, code, typeof args[0] === 'string' ? args[0] : '');
        let response;
        try {
          response = await originalFetch(...args);
        } catch (error) {
          if (attempt && code) bodies.push({ time: now(), body: null, attemptId: attempt.id, code, networkError: String(error && error.message || error) });
          throw error;
        }
        const httpStatus = response.status;
        response.clone().json()
          .then((body) => recordBody(body, attempt && attempt.id, code, httpStatus))
          .catch(() => {});
        return response;
      };
    }

    if (originalOpen && originalSend) {
      root.XMLHttpRequest.prototype.open = function tappedOpen(...args) {
        this.__dfRedeemUrl = args[1];
        return originalOpen.apply(this, args);
      };
      root.XMLHttpRequest.prototype.send = function tappedSend(...args) {
        const attempt = active ? { id: active.id, code: active.code } : null;
        const code = scan([this.__dfRedeemUrl, args[0]], 0, attempt && attempt.code);
        recordStart(attempt && attempt.id, code, this.__dfRedeemUrl);
        const xhr = this;
        this.addEventListener('loadend', () => {
          try {
            if (typeof xhr.responseText === 'string' && xhr.responseText.trim()) {
              recordBody(JSON.parse(xhr.responseText), attempt && attempt.id, code, xhr.status);
            }
          } catch (_) { /* not JSON */ }
        });
        return originalSend.apply(this, args);
      };
    }

    return {
      begin(attempt) { active = attempt; },
      end() { active = null; },
      reset() { bodies.length = 0; starts.length = 0; },
      started(attempt) { return starts.some((s) => s.attemptId === attempt.id && s.code === attempt.code); },
      bodyFor(attempt) {
        return bodies
          .filter((b) => b.attemptId === attempt.id && b.code === attempt.code)
          .sort((a, b) => a.time - b.time)[0] || null;
      },
      restore() {
        if (restored) return;
        if (originalFetch) root.fetch = originalFetch;
        if (originalOpen && originalSend) {
          root.XMLHttpRequest.prototype.open = originalOpen;
          root.XMLHttpRequest.prototype.send = originalSend;
        }
        restored = true;
      },
    };
  }

  /* ── Runner ───────────────────────────────────────────────────────────── */

  class RedeemRun {
    constructor(entries, options) {
      this.config = Object.assign({}, DEFAULTS, options || {});
      this.queue = entries.map((entry, index) => (typeof entry === 'string'
        ? { code: entry, hint: '', index }
        : { code: entry.code, hint: entry.hint || '', family: entry.family, source: entry.source, index }));
      this.results = [];
      this.byCode = new Map();
      this.startedAt = null;
      this.endedAt = null;
      this.stopRequested = false;
      this.stopReason = '';
      this.paused = false;
      this.attemptCounter = 0;
      this.cleanStreak = 0;
      this.currentDelay = this.config.delayMs;
      this.listeners = { progress: [], result: [], done: [], log: [] };
      this.state = 'idle';
      // The matcher must recognise every code the run may ever submit — the
      // queue codes AND any OCR variant generated later. Registering variants
      // lazily keeps a variant's response from being discarded as "unmatched",
      // which would silently throw away a correct reading.
      this.knownCodes = new Set(this.queue.map((q) => q.code));
      this.tap = createNetworkTap((text, activeCode) => {
        if (!text) return '';
        const upper = text.toUpperCase();
        // The code currently being submitted always wins. Without this, a
        // variant that differs from its parent only by case (DFUItra220 vs
        // DFUltra220) would be credited to the parent and its real verdict lost.
        if (activeCode && (text.indexOf(activeCode) !== -1 || upper.indexOf(activeCode.toUpperCase()) !== -1)) {
          return activeCode;
        }
        // Longest first so DFWIN360 never shadows DFWIN3601.
        const candidates = Array.from(this.knownCodes).sort((a, b) => b.length - a.length);
        // Exact matches across all candidates before any case-insensitive one.
        for (const code of candidates) {
          if (text.indexOf(code) !== -1) return code;
        }
        for (const code of candidates) {
          if (upper.indexOf(code.toUpperCase()) !== -1) return code;
        }
        return '';
      });
    }

    /** Register a code the tap must be able to attribute responses to. */
    trackCode(code) {
      if (code) this.knownCodes.add(code);
    }

    on(event, handler) {
      if (this.listeners[event]) this.listeners[event].push(handler);
      return this;
    }

    emit(event, payload) {
      for (const handler of this.listeners[event] || []) {
        try { handler(payload); } catch (_) { /* listener must not break the run */ }
      }
    }

    log(message, tone) {
      this.emit('log', { time: now(), message, tone: tone || 'info' });
    }

    stop(reason) {
      this.stopRequested = true;
      this.stopReason = reason || 'Đã dừng theo yêu cầu.';
    }

    pause() { this.paused = true; }
    resume() { this.paused = false; }

    summary() {
      const counts = {};
      for (const result of this.results) counts[result.status] = (counts[result.status] || 0) + 1;
      const success = this.results.filter((r) => r.status === 'SUCCESS');
      return {
        total: this.queue.length,
        processed: this.results.length,
        success: success.length,
        successCodes: success.map((r) => r.code),
        counts,
        elapsedMs: this.startedAt ? (this.endedAt || now()) - this.startedAt : 0,
        currentDelay: this.currentDelay,
      };
    }

    /** One submit + response read. Never decides SUCCESS from the DOM. */
    async attempt(code, position) {
      await clearMessages();
      const input = findInput();
      const button = findButton();
      if (!input || !button) {
        return { status: 'SCRIPT_ERROR', label: Garena.label('SCRIPT_ERROR'), detail: 'Không tìm thấy ô nhập hoặc nút Đổi trên trang.', trusted: false, errorCode: null, pageText: '' };
      }

      setValue(input, '');
      await sleep(40);
      setValue(input, code);
      await sleep(60);
      if (String(input.value).trim() !== code) {
        return { status: 'SCRIPT_ERROR', label: Garena.label('SCRIPT_ERROR'), detail: `Ô nhập không giữ đúng giá trị (đang là "${input.value}").`, trusted: false, errorCode: null, pageText: '' };
      }

      this.tap.reset();
      const attempt = { id: ++this.attemptCounter, code, startedAt: now() };
      this.tap.begin(attempt);

      let requestSent = false;
      for (let click = 0; click <= this.config.submitClickRetries; click += 1) {
        const target = click === 0 ? button : findButton();
        if (!target) break;
        realClick(target);
        const confirmStart = now();
        while (now() - confirmStart < this.config.submitConfirmMs) {
          await sleep(50);
          if (this.tap.started(attempt) || this.tap.bodyFor(attempt)) { requestSent = true; break; }
        }
        if (requestSent) break;
        if (click < this.config.submitClickRetries) this.log(`Click chưa tạo request, bấm lại: ${code}`, 'warn');
      }

      let record = null;
      const deadline = now() + this.config.responseTimeoutMs;
      while (now() < deadline) {
        await sleep(100);
        record = this.tap.bodyFor(attempt);
        if (record) break;
      }
      const pageMessage = readPageMessage();
      this.tap.end();
      closeDialog();

      if (record && record.body) {
        const verdict = Garena.classifyResponse(record.body, record.httpStatus);
        return Object.assign({}, verdict, { pageText: pageMessage.text, httpStatus: record.httpStatus, raw: record.body });
      }
      if (record && record.networkError) {
        return { status: 'NETWORK', label: Garena.label('NETWORK'), detail: `Lỗi mạng: ${record.networkError}`, trusted: false, errorCode: null, pageText: pageMessage.text };
      }

      // No network body. Describe what the page showed but never call it a win.
      const fallback = Garena.classifyText(pageMessage.text);
      if (fallback.status === 'SUCCESS' || fallback.status === 'OTHER' || fallback.status === 'NO_RESPONSE') {
        return {
          status: 'NO_RESPONSE',
          label: Garena.label('NO_RESPONSE'),
          detail: pageMessage.text
            ? `Không bắt được phản hồi mạng để xác nhận. Trang hiện: "${pageMessage.text}"`
            : (requestSent ? 'Đã gửi yêu cầu nhưng Garena không trả lời kịp.' : 'Click không tạo ra request nào.'),
          trusted: false, errorCode: null, pageText: pageMessage.text,
        };
      }
      // A clearly negative page message is informative enough to act on.
      return {
        status: fallback.status,
        label: Garena.label(fallback.status),
        detail: `Đọc từ thông báo trên trang (không có body mạng): "${pageMessage.text}"`,
        trusted: false, errorCode: null, pageText: pageMessage.text,
      };
    }

    /** Adapt pacing to how the server is behaving. */
    adjustPacing(status) {
      if (status === 'RATE_LIMITED' || status === 'NO_RESPONSE' || status === 'TEMP_ERROR' || status === 'NETWORK') {
        this.cleanStreak = 0;
        this.currentDelay = Math.min(this.config.maxDelayMs, Math.round(this.currentDelay * this.config.slowDownFactor));
        this.log(`Giãn nhịp lên ${this.currentDelay}ms do gặp ${Garena.label(status)}.`, 'warn');
        return;
      }
      this.cleanStreak += 1;
      if (this.cleanStreak >= this.config.speedUpAfter && this.currentDelay > this.config.minDelayMs) {
        this.currentDelay = Math.max(this.config.minDelayMs, this.currentDelay - this.config.speedUpStepMs);
        this.cleanStreak = 0;
      }
    }

    async run() {
      if (this.state === 'running') return this.summary();
      this.state = 'running';
      this.startedAt = now();
      this.log(`Bắt đầu ${this.queue.length} code. Nhịp ${this.currentDelay}ms, chờ phản hồi ${this.config.responseTimeoutMs}ms.`, 'info');

      try {
        for (let i = 0; i < this.queue.length; i += 1) {
          if (this.stopRequested) break;
          while (this.paused && !this.stopRequested) await sleep(300);
          if (this.stopRequested) break;

          const item = this.queue[i];
          const position = i + 1;
          const attemptsLog = [];
          let verdict = null;
          let usedCode = item.code;
          let variantsTried = [];

          this.emit('progress', { position, total: this.queue.length, code: item.code, phase: 'Đang gửi' });

          // main attempt, with retries for transient states
          for (let tryNo = 0; tryNo <= this.config.maxRetries; tryNo += 1) {
            verdict = await this.attempt(item.code, position);
            attemptsLog.push({ code: item.code, try: tryNo + 1, status: verdict.status, detail: verdict.detail });
            if (!Garena.RETRYABLE.has(verdict.status)) break;
            if (tryNo < this.config.maxRetries) {
              const wait = this.config.retryDelayMs * Math.pow(2, tryNo);
              this.emit('progress', { position, total: this.queue.length, code: item.code, phase: `Thử lại sau ${Math.round(wait / 1000)}s` });
              this.log(`${item.code}: ${Garena.label(verdict.status)} → thử lại sau ${wait}ms`, 'warn');
              await sleep(wait);
            }
          }

          // OCR variant probing, only when Garena says the code does not exist
          if (this.config.tryVariants && Garena.VARIANT_WORTHY.has(verdict.status) && item.source !== 'file') {
            const variants = Codes.ocrVariants(item.code, this.config.maxVariants);
            for (const variant of variants) {
              if (this.stopRequested) break;
              // The tap must know this code before the request goes out.
              this.trackCode(variant);
              this.emit('progress', { position, total: this.queue.length, code: variant, phase: 'Thử biến thể OCR' });
              await sleep(Math.round(this.currentDelay * 0.6));
              const probe = await this.attempt(variant, position);
              variantsTried.push({ code: variant, status: probe.status, detail: probe.detail });
              attemptsLog.push({ code: variant, try: 1, status: probe.status, detail: probe.detail, variant: true });
              if (Garena.CODE_IS_REAL.has(probe.status)) {
                this.log(`${item.code} sai OCR → ${variant} là mã thật (${Garena.label(probe.status)}).`, 'ok');
                verdict = probe;
                usedCode = variant;
                break;
              }
              if (Garena.FATAL.has(probe.status)) { verdict = probe; break; }
            }
          }

          const result = {
            position,
            total: this.queue.length,
            code: item.code,
            redeemedAs: usedCode,
            hint: item.hint || '',
            family: item.family || (Codes ? Codes.classifyFamily(item.code) : ''),
            source: item.source || '',
            status: verdict.status,
            label: verdict.label || Garena.label(verdict.status),
            detail: verdict.detail || '',
            errorCode: verdict.errorCode == null ? '' : verdict.errorCode,
            trusted: Boolean(verdict.trusted),
            pageText: verdict.pageText || '',
            variantsTried,
            attempts: attemptsLog,
            at: new Date().toISOString(),
          };
          this.results.push(result);
          this.byCode.set(item.code, result);
          this.emit('result', result);
          this.log(`[${position}/${this.queue.length}] ${result.label} — ${usedCode}${usedCode !== item.code ? ` (gốc ${item.code})` : ''}: ${result.detail}`,
            result.status === 'SUCCESS' ? 'ok' : (Garena.CODE_IS_REAL.has(result.status) ? 'info' : 'warn'));

          if (Garena.FATAL.has(result.status) && this.config.stopOnFatal) {
            this.stop(`Dừng vì ${result.label}: ${result.detail}`);
            break;
          }
          this.adjustPacing(result.status);
          if (i < this.queue.length - 1 && !this.stopRequested) {
            const jitter = Math.round(Math.random() * this.config.jitterMs);
            await sleep(this.currentDelay + jitter);
          }
        }
      } finally {
        this.endedAt = now();
        this.state = 'done';
        this.tap.restore();
      }

      const summary = this.summary();
      summary.stopped = this.stopRequested;
      summary.stopReason = this.stopReason;
      this.emit('done', summary);
      this.log(this.stopRequested ? this.stopReason : `Hoàn tất. Thành công ${summary.success}/${summary.total}.`,
        this.stopRequested ? 'warn' : 'ok');
      return summary;
    }

    /** Codes worth another pass in a later run. */
    retryable() {
      return this.results.filter((r) => Garena.RETRYABLE.has(r.status)).map((r) => r.code);
    }

    toCSV() {
      const columns = ['position', 'code', 'redeemedAs', 'status', 'label', 'errorCode', 'trusted', 'family', 'source', 'hint', 'detail', 'pageText', 'variantsTried', 'at'];
      const escape = (value) => {
        const text = value == null ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines = [columns.join(',')];
      for (const r of this.results) {
        lines.push(columns.map((col) => escape(col === 'variantsTried'
          ? r.variantsTried.map((v) => `${v.code}=${v.status}`).join(' | ')
          : r[col])).join(','));
      }
      return '\ufeff' + lines.join('\r\n');
    }

    toJSON() {
      return JSON.stringify({
        tool: 'df-redeem',
        startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
        endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
        config: this.config,
        summary: this.summary(),
        results: this.results,
      }, null, 2);
    }
  }

  const api = { RedeemRun, DEFAULTS, SELECTORS, findInput, findButton, setValue, realClick, readPageMessage, createNetworkTap, sleep };
  root.DFRedeemEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));
