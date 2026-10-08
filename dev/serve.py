"""ローカル動作確認用サーバー。

本物の gas/Code.gs をブラウザで動かし（dev/gas-stub.js がスプレッドシート等を模擬）、
gas/Index.html（?page=admin なら gas/Admin.html）を表示する。データはブラウザの localStorage に保存される。

    python3 dev/serve.py        → http://127.0.0.1:8765/
    python3 dev/serve.py --lan  → 同じWi-Fi内のスマホからも開ける（http://<このMacのIP>:8765/）
"""
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(ARGS[0]) if ARGS else 8765
HOST = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"
INJECT = (
    '<script src="/dev/gas-stub.js"></script>\n'
    '<script src="/gas/Code.gs"></script>\n'
    '<script src="/dev/seed.js"></script>\n'
)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0].split("#")[0]
        if path in ("/", "/index.html"):
            # 本番と同じく ?page=admin で管理画面を返す
            page = "Admin.html" if "page=admin" in self.path else "Index.html"
            html = (ROOT / "gas" / page).read_text(encoding="utf-8")
            body = html.replace("<script>", INJECT + "<script>", 1).encode("utf-8")
            ctype = "text/html; charset=utf-8"
        elif path in ("/gas/Code.gs", "/dev/gas-stub.js", "/dev/seed.js"):
            body = (ROOT / path.lstrip("/")).read_bytes()
            ctype = "text/javascript; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}/")
    http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
