"""ローカル動作確認用サーバー。

web/ の画面をそのまま配信し、本物の gas/Code.gs をブラウザ上で動かす
（dev/gas-stub.js がスプレッドシート等を模擬し、GAS への fetch を横取りして Code.gs の doPost に渡す）。
データはブラウザの localStorage に保存される。
Cloudflare の「予約の正本」（cache/store.js）もブラウザの中で動かし（dev/cf-stub.js）、そのデータベースは
このサーバーの /dev-sql（メモリ上の SQLite。サーバーを止めると消える）に置く。

    python3 dev/serve.py        → http://127.0.0.1:8765/（管理画面は /admin.html）
    python3 dev/serve.py --lan  → 同じWi-Fi内のスマホからも開ける（http://<このMacのIP>:8765/）
"""
import http.server
import json
import pathlib
import sqlite3
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(ARGS[0]) if ARGS else 8765
HOST = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"
# web/config.js の代わりに読み込ませる（本物の接続先には通信しない）
DEV_CONFIG = (b"window.GAS_API_URL = 'https://script.google.com/macros/s/dev-stub/exec';\n"
              b"window.CACHE_API_URL = 'http://dev-cf.test';\n")
INJECT = (
    '<script src="/dev/fixed-time.js"></script>\n'
    '<script src="/dev/gas-stub.js"></script>\n'
    '<script src="/gas/Code.gs"></script>\n'
    '<script src="/cache/store.js"></script>\n'
    '<script src="/dev/cf-stub.js"></script>\n'
    '<script src="/dev/seed.js"></script>\n'
)
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".gs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0].split("#")[0]
        if path == "/":
            path = "/index.html"
        if path == "/config.js":
            body = DEV_CONFIG
        elif path in ("/gas/Code.gs", "/cache/store.js", "/dev/gas-stub.js", "/dev/cf-stub.js", "/dev/seed.js", "/dev/fixed-time.js", "/dev/fingerprint.js", "/dev/compare-scenario.js"):
            body = (ROOT / path.lstrip("/")).read_bytes()
        else:
            file = (WEB / path.lstrip("/")).resolve()
            if WEB not in file.parents or not file.is_file():
                self.send_error(404)
                return
            body = file.read_bytes()
            if file.suffix == ".html":
                html = body.decode("utf-8")
                body = html.replace('<script src="config.js">', INJECT + '<script src="config.js">', 1).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(pathlib.Path(path).suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        """/dev-sql: Cloudflare の正本のデータベースの代わり。{q: SQL, b: [値...]} を1つ実行して行を返す"""
        if self.path != "/dev-sql":
            self.send_error(404)
            return
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        global DB
        with DB_LOCK:
            try:
                if req["q"] == "__RESET__":
                    DB.close()
                    DB = new_db()
                    rows = []
                else:
                    cur = DB.execute(req["q"], req.get("b") or [])
                    rows = [dict(r) for r in cur.fetchall()]
                out = {"rows": rows}
            except Exception as e:  # noqa: BLE001
                out = {"error": str(e)}
        body = json.dumps(out).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def new_db():
    db = sqlite3.connect(":memory:", check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    return db


DB = new_db()
DB_LOCK = threading.Lock()


if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}/")
    http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
