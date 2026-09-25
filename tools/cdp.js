/* cdp.js — a tiny CDP driver for verifying the built extension in real Chrome.
 *
 * No dependencies: Node's global WebSocket talks to the DevTools endpoint
 * directly. Each helper resolves when its command's id comes back, so callers
 * can await page loads and evaluations in sequence.
 */
'use strict';

const ENDPOINT = process.env.CDP || 'http://127.0.0.1:9333';

async function targets() {
  const res = await fetch(ENDPOINT + '/json/list');
  return res.json();
}

/* One live connection to one target, with an await-able send(). */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error('ws failed: ' + wsUrl)), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });

  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); fail(new Error('timeout: ' + method)); }
    }, 30000);
  });

  /* Evaluate in the page and return the plain value. Throws page exceptions
   * rather than swallowing them, so a broken view fails the check loudly. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page threw: ' + (d.exception && d.exception.description || d.text));
    }
    return r.result.value;
  };

  const navigate = async (url) => {
    await send('Page.enable');
    await send('Page.navigate', { url });
    /* Poll for readyState instead of racing the loadEventFired event. */
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const state = await evaluate('document.readyState');
        if (state === 'complete') return;
      } catch { /* navigating: the old context is gone, keep polling */ }
    }
    throw new Error('navigation never completed: ' + url);
  };

  return { send, evaluate, navigate, events, close: () => ws.close() };
}

/* Console + uncaught errors, collected for the duration of a check. */
async function watchConsole(cx) {
  const logs = [];
  await cx.send('Runtime.enable');
  await cx.send('Log.enable');
  const hook = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('exception: ' + (d.exception && d.exception.description || d.text));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      logs.push('log: ' + m.params.entry.text);
    }
  };
  return { logs, hook };
}

module.exports = { ENDPOINT, targets, attach, watchConsole };
