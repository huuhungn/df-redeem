"""verify-extension.py — prove the packed extension actually loads and injects.

Drives the isolated Chrome over CDP: lists extension targets, opens a page that
imitates the Garena redeem DOM on an https origin the manifest matches, then
checks the content script installed the panel there.
"""
import json
import urllib.request
import websocket


def targets(port=9335):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as r:
        return json.load(r)


def new_tab(url, port=9335):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?{url}", method="PUT")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


class Tab:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30)
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
            return {"error": res["exceptionDetails"].get("text")}
        return res.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    ext_targets = [t for t in targets() if "chrome-extension" in t.get("url", "")]
    print("extension targets seen:")
    for t in ext_targets:
        print("  ", t.get("type"), t.get("url", "")[:95])

    # Ask the browser which extensions are installed, via an extension's own
    # service worker is not possible without its id, so probe the manifest name
    # by opening chrome://extensions is blocked from CDP eval. Instead, verify
    # the content script by loading a matching origin. The manifest only matches
    # redeem.df.garena.sg, so hit the real (public) page — no login needed to
    # observe injection.
    tab = new_tab("https://redeem.df.garena.sg/vi/cdkgarena.html")
    ws_url = tab["webSocketDebuggerUrl"]
    t = Tab(ws_url)
    t.send("Page.enable")
    t.send("Runtime.enable")

    import time
    for _ in range(30):
        state = t.eval("document.readyState")
        if state == "complete":
            break
        time.sleep(1)

    time.sleep(3)  # document_idle + panel mount

    report = t.eval("""(() => {
      const host = Array.from(document.querySelectorAll('*'))
        .find(e => e.shadowRoot && /Đổi code hàng loạt/.test(e.shadowRoot.textContent || ''));
      return JSON.stringify({
        url: location.href,
        readyState: document.readyState,
        engineInstalled: !!window.DFRedeemEngine,
        codesInstalled: !!window.DFRedeemCodes,
        panelHostFound: !!host,
        launcherFound: !!(host && host.shadowRoot.querySelector('.launcher')),
        tabs: host ? Array.from(host.shadowRoot.querySelectorAll('button.tab')).map(b => b.textContent.trim()) : [],
        inputFound: !!document.querySelector('.exc-input'),
        buttonFound: !!document.querySelector('.btn-exchange'),
      });
    })()""")
    print("\ninjection report:")
    print(report)
    t.close()
