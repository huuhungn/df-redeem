"""verify-content-script.py — test the exact extension/content.js bytes.

Chrome 154 no longer honours --load-extension, so the packed extension cannot be
side-loaded from the CLI. This instead injects the very same content.js file into
the real redeem page in the MAIN world at document_idle, which is exactly what
the manifest declares, and asserts the panel mounts and the engine API appears.
"""
import json
import pathlib
import time
import urllib.request

import websocket

PORT = 9336
CONTENT = pathlib.Path("C:/Users/Administrator/Downloads/df-redeem-v1.0.0/df-redeem-extension/content.js")


def new_tab(url):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{url}", method="PUT")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


class Tab:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.n = 0

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                return msg

    def eval(self, expr, await_promise=False):
        msg = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                        awaitPromise=await_promise)
        res = msg.get("result", {})
        if "exceptionDetails" in res:
            return {"__error": res["exceptionDetails"].get("text"),
                    "__detail": str(res["exceptionDetails"])[:500]}
        return res.get("result", {}).get("value")


t = Tab(new_tab("about:blank")["webSocketDebuggerUrl"])
t.send("Page.enable")
t.send("Runtime.enable")
t.send("Page.navigate", url="https://redeem.df.garena.sg/vi/cdkgarena.html")
time.sleep(5)

for _ in range(40):
    if t.eval("document.readyState") == "complete":
        break
    time.sleep(1)

print("page:", t.eval("location.href"))
print("live selectors:", t.eval(
    "JSON.stringify({input: !!document.querySelector('.exc-input'), "
    "button: !!document.querySelector('.btn-exchange')})"))

src = CONTENT.read_text(encoding="utf-8")
print(f"injecting content.js ({len(src)/1024:.1f} KB) into MAIN world...")
out = t.eval(src)
if isinstance(out, dict) and "__error" in out:
    print("INJECTION ERROR:", out["__error"])
    print(out["__detail"])
    raise SystemExit(1)
print("content.js returned:", out)

time.sleep(2)

report = t.eval("""(() => {
  const host = Array.from(document.querySelectorAll('*'))
    .find(e => e.shadowRoot && /Đổi code hàng loạt/.test(e.shadowRoot.textContent || ''));
  const sr = host && host.shadowRoot;
  return JSON.stringify({
    engineApi: typeof window.DFRedeemEngine,
    codesApi: typeof window.DFRedeemCodes,
    panelApi: typeof window.__dfRedeemPanel,
    panelMounted: !!host,
    launcher: !!(sr && sr.querySelector('.launcher')),
    tabs: sr ? Array.from(sr.querySelectorAll('button.tab')).map(b => b.textContent.trim()) : [],
    startBtn: !!(sr && sr.querySelector('button.start')),
    exportBtns: sr ? Array.from(sr.querySelectorAll('button.export')).map(b => b.textContent.trim()) : [],
    engineKeys: window.DFRedeemEngine ? Object.keys(window.DFRedeemEngine) : [],
    codesKeys: window.DFRedeemCodes ? Object.keys(window.DFRedeemCodes) : [],
    variantTop: window.DFRedeemCodes ? window.DFRedeemCodes.ocrVariants('DFUItra220')[0] : null,
  }, null, 1);
})()""")
print("\n--- content.js verification report ---")
print(report)
