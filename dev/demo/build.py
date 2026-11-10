"""デモサーバー（Cloudflare Workers）に置くファイルを作る。

dev/serve.py のテスト環境と同じ形（本物の gas/Code.gs と cache/store.js をブラウザの中で動かす）を、
静的なファイルにまとめて dev/demo/dist/ に書き出す。/dev-sql は worker.js が Durable Object の SQLite で受ける。
公開は dev/demo/deploy.sh から。本番の画面・GAS・高速キャッシュとは別物で、本物の接続先には通信しない。
"""
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
WEB = ROOT / "web"
DIST = pathlib.Path(__file__).resolve().parent / "dist"

# 拡張子 .gs は種類が判らず、スクリプトとして読まれないことがあるので .js にして置く
INJECT = (
    '<script src="/dev/fixed-time.js"></script>\n'
    '<script src="/dev/gas-stub.js"></script>\n'
    '<script src="/gas/Code.gs.js"></script>\n'
    '<script src="/cache/store.js"></script>\n'
    '<script src="/dev/cf-stub.js"></script>\n'
    '<script src="/dev/seed.js"></script>\n'
)
DEV_CONFIG = ("window.GAS_API_URL = 'https://script.google.com/macros/s/dev-stub/exec';\n"
              "window.CACHE_API_URL = 'http://dev-cf.test';\n")

if DIST.exists():
    shutil.rmtree(DIST)
shutil.copytree(WEB, DIST)
(DIST / "sw.js").unlink()  # デモでは Service Worker を使わない（古い画面が残らないように）
(DIST / "config.js").write_text(DEV_CONFIG, encoding="utf-8")
for html in DIST.glob("*.html"):
    s = html.read_text(encoding="utf-8")
    if '<script src="config.js">' in s:
        html.write_text(s.replace('<script src="config.js">', INJECT + '<script src="config.js">', 1), encoding="utf-8")
(DIST / "gas").mkdir()
shutil.copy(ROOT / "gas/Code.gs", DIST / "gas/Code.gs.js")
(DIST / "cache").mkdir()
shutil.copy(ROOT / "cache/store.js", DIST / "cache/store.js")
(DIST / "dev").mkdir()
for name in ("fixed-time.js", "gas-stub.js", "cf-stub.js", "seed.js"):
    shutil.copy(ROOT / "dev" / name, DIST / "dev" / name)
print(DIST)

# 画面のファイルを Worker の中に埋め込む（Workers の静的アセットのアップロードを使わずに済むように）
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json"}
import base64
import json
files = {}
for f in sorted(DIST.rglob("*")):
    if f.is_file():
        files["/" + f.relative_to(DIST).as_posix()] = [TYPES.get(f.suffix, "application/octet-stream"), base64.b64encode(f.read_bytes()).decode()]
(DIST.parent / "files.js").write_text("export default " + json.dumps(files) + ";\n", encoding="utf-8")
print(len(files), "files")
