"""check-ext-page.py — read chrome://extensions in the test profile over CDP.

Uses the extensions page's own management API surface to report what Chrome
thinks is installed, so we can tell a bad manifest apart from Chrome ignoring
the --load-extension flag.
"""
import json
import time
import urllib.request

import websocket

PORT = 9335


def new_tab(url):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{url}", method="PUT")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


class Tab:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self.n = 0

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                return msg

    def eval(self, expr):
        msg = self.send("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        res = msg.get("result", {})
        if "exceptionDetails" in res:
            return {"error": res["exceptionDetails"].get("text"),
                    "detail": str(res["exceptionDetails"])[:400]}
        return res.get("result", {}).get("value")


t = Tab(new_tab("chrome://extensions/")["webSocketDebuggerUrl"])
t.send("Page.enable")
t.send("Runtime.enable")
time.sleep(3)

print("--- chrome.developerPrivate.getExtensionsInfo ---")
print(t.eval("""new Promise((resolve) => {
  try {
    chrome.developerPrivate.getExtensionsInfo({includeDisabled: true, includeTerminated: true}, (list) => {
      resolve(JSON.stringify((list || []).map(e => ({
        name: e.name, id: e.id, state: e.state, type: e.type,
        errors: (e.manifestErrors || []).concat(e.runtimeErrors || []).map(x => x.message || String(x)),
        installWarnings: e.installWarnings || [],
      })), null, 1));
    });
  } catch (err) { resolve('developerPrivate unavailable: ' + err.message); }
})"""))
