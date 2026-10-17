# -*- coding: utf-8 -*-
"""用 Chrome DevTools Protocol 抓取需要交互才能出现的界面（对话框、属性面板）。

用法：python _shot.py <plan.json>
plan 为 [{"id": "...", "url": "...", "steps": [{"js": "..."}], "wait": 1200}]
"""
import base64
import json
import os
import subprocess
import sys
import time

import requests
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "images")


class Cdp:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60)
        self.mid = 0

    def send(self, method, **params):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result", {})

    def js(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")


def wait_ready(cdp, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cdp.js("document.readyState") == "complete" and cdp.js(
                "!!document.querySelector('app-root > *')"
            ):
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def main():
    plan = json.load(open(sys.argv[1], encoding="utf-8"))
    profile = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmp", "cdp-profile")
    os.makedirs(profile, exist_ok=True)
    proc = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--remote-allow-origins=*",
            "--window-size=1600,1000",
            "--remote-debugging-port=%d" % PORT,
            "--user-data-dir=" + profile,
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(40):
            try:
                tabs = requests.get("http://127.0.0.1:%d/json" % PORT, timeout=2).json()
                pages = [t for t in tabs if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if not ws_url:
            raise SystemExit("无法连接 Chrome 调试端口")
        cdp = Cdp(ws_url)
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        cdp.send(
            "Emulation.setDeviceMetricsOverride",
            width=1600,
            height=1000,
            deviceScaleFactor=1,
            mobile=False,
        )
        for item in plan:
            cdp.send("Page.navigate", url=item["url"])
            ok = wait_ready(cdp)
            time.sleep(item.get("settle", 2.5))
            for step in item.get("steps", []):
                if "js" in step:
                    cdp.js(step["js"])
                time.sleep(step.get("wait", 1.2) / 1000.0)
            shot = cdp.send("Page.captureScreenshot", format="png", captureBeyondViewport=False)
            path = os.path.join(OUT_DIR, item["id"] + ".png")
            with open(path, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            title = cdp.js("document.title")
            print("OK %-32s ready=%s title=%s" % (item["id"], ok, title))
    finally:
        proc.terminate()
        time.sleep(1)
        try:
            proc.kill()
        except Exception:
            pass


if __name__ == "__main__":
    main()
