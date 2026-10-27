#!/usr/bin/env bash
# gas/Code.gs を Apps Script に反映し、今のウェブアプリのデプロイを新しいバージョンに差し替える。
# URL は変わらない（「デプロイを管理」で鉛筆を押して新バージョンにするのと同じ）。
#
# 使い方（リポジトリのどこからでも）:
#   ./dev/gas-deploy.sh          … 確かめながら反映する（ふだんはこちら）
#   ./dev/gas-deploy.sh --ci     … 何も尋ねずに反映する（GitHub Actions 用。git の状態は確かめない）
#
# 準備（最初の1回。保守マニュアル 03 の 2章）:
#   - Node.js 20 以上
#   - https://script.google.com/home/usersettings で「Google Apps Script API」をオンにする
#   - npx @google/clasp@3.4.1 login（~/.clasprc.json ができる）
#   - gas/.clasp-script-id に、Apps Script の「プロジェクトの設定」にあるスクリプト ID を1行で書く
#     （または環境変数 GAS_SCRIPT_ID に入れる）
#
# 流れ: 一時フォルダに GAS の今の中身（appsscript.json と .gs）を取る → .gs がちょうど1つなら
#       その中身を gas/Code.gs で置き換える → 送る → 既存のデプロイを新しいバージョンにする。
#       appsscript.json は GAS から取ったものをそのまま送り返す（リポジトリのものは使わない）。
#
# Mac の bash 3.2 でも動くように書いている（連想配列などを使わない）。

set -euo pipefail

CLASP_VERSION='3.4.1'   # 版を固定する。上げるときはここだけ変える
CI_MODE=0

for arg in "$@"; do
  case "$arg" in
    --ci) CI_MODE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "知らない指定です: $arg（--ci か --help）" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

# はい／いいえを尋ねる。--ci のときは尋ねない（呼ぶ側で分ける）
ask_yes() {
  local ans
  printf '%s [y/N] ' "$1"
  read -r ans || ans=''
  case "$ans" in y|Y|yes|YES|はい) return 0 ;; *) return 1 ;; esac
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

clasp() { npx --yes "@google/clasp@${CLASP_VERSION}" "$@"; }

command -v node >/dev/null 2>&1 || fail 'Node.js が見つかりません。https://nodejs.org/ から入れてください（20 以上）。'
command -v npx  >/dev/null 2>&1 || fail 'npx が見つかりません。Node.js を入れ直してください。'
[ -f gas/Code.gs ]  || fail 'gas/Code.gs がありません。'
[ -f web/config.js ] || fail 'web/config.js がありません。'

# --- スクリプト ID（どの Apps Script のプロジェクトか） ---
SCRIPT_ID="${GAS_SCRIPT_ID:-}"
if [ -z "$SCRIPT_ID" ] && [ -f gas/.clasp-script-id ]; then
  SCRIPT_ID="$(tr -d ' \t\r\n' < gas/.clasp-script-id)"
fi
if [ -z "$SCRIPT_ID" ]; then
  say 'スクリプト ID が決まっていません。'
  say 'Apps Script の「プロジェクトの設定」にあるスクリプト ID を入れてください。'
  say '  例: echo "（スクリプト ID）" >| gas/.clasp-script-id'
  say '（GitHub Actions では Secret の GAS_SCRIPT_ID でもよい。保守マニュアル 03 の 2章）'
  exit 1
fi

# --- デプロイ ID（web/config.js の GAS_API_URL の /macros/s/<ここ>/exec） ---
DEPLOYMENT_ID="$(sed -n "s#.*GAS_API_URL *= *['\"]https://script.google.com/macros/s/\([^/'\"]*\)/exec['\"].*#\1#p" web/config.js | head -n 1)"
[ -n "$DEPLOYMENT_ID" ] || fail 'web/config.js の GAS_API_URL からデプロイ ID を読めませんでした（…/macros/s/<ID>/exec の形か確かめてください）。'

# --- git の状態（--ci では確かめない。Actions は main の push のときだけ動く） ---
if [ "$CI_MODE" -eq 0 ] && command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  warn=''
  if [ -n "$(git status --porcelain -- gas web/config.js)" ]; then
    warn="${warn}  - gas/ か web/config.js にコミットしていない変更があります（そのままの中身を送ります）。"$'\n'
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != 'main' ]; then
    warn="${warn}  - 今のブランチは「${branch}」で、main ではありません。"$'\n'
  fi
  if git rev-parse --verify -q origin/main >/dev/null && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    warn="${warn}  - 手元の HEAD が origin/main と違います（push 前か、取り込み前）。"$'\n'
  fi
  if [ -n "$warn" ]; then
    say '注意:'
    printf '%s' "$warn"
    ask_yes 'このまま続けますか？' || { say 'やめました。'; exit 1; }
  fi
fi

# --- ログイン ---
logged_in() { clasp --json show-authorized-user 2>/dev/null | grep -q '"loggedIn": *true'; }
if ! logged_in; then
  if [ "$CI_MODE" -eq 1 ]; then
    fail 'clasp にログインしていません（Secret の CLASPRC_JSON を確かめてください。パスワードを変えると無効になります）。'
  fi
  say 'clasp にログインしていません。ブラウザで Google のアカウントを選んでください（GAS をデプロイしている人のアカウント）。'
  ask_yes '今ログインしますか？' || { say "あとで npx @google/clasp@${CLASP_VERSION} login を実行してください。"; exit 1; }
  clasp login
  logged_in || fail 'ログインできませんでした。'
fi

# --- 一時フォルダで GAS の今の中身を取る ---
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gas-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
# scriptExtensions を .gs にして、GAS 側の名前（「コード」でも「Code」でも）のまま .gs で受け取る
printf '{"scriptId":"%s","rootDir":"src","scriptExtensions":[".gs"]}\n' "$SCRIPT_ID" >| "$WORK/.clasp.json"

hint_api='Apps Script API がオンか（https://script.google.com/home/usersettings）、スクリプト ID が正しいか、ログイン中のアカウントがそのプロジェクトを編集できるかを確かめてください。'

say "GAS の今の中身を取っています（スクリプト ID: ${SCRIPT_ID}）…"
( cd "$WORK" && clasp pull ) || fail "取れませんでした。${hint_api}"

[ -f "$WORK/src/appsscript.json" ] || fail 'GAS から appsscript.json が取れませんでした。'

GS_LIST="$(cd "$WORK/src" && find . -type f -name '*.gs' | sed 's#^\./##')"
GS_COUNT="$(printf '%s' "$GS_LIST" | grep -c . || true)"
if [ "$GS_COUNT" -ne 1 ]; then
  say "GAS 側の .gs ファイルが ${GS_COUNT} 個あります（ちょうど1つのときだけ置き換えます）:"
  [ "$GS_COUNT" -eq 0 ] || printf '%s\n' "$GS_LIST" | sed 's/^/  - /'
  fail 'Apps Script エディタで1つにまとめるか、従来どおり手で貼り付けてください。'
fi
GS_FILE="$GS_LIST"

if cmp -s gas/Code.gs "$WORK/src/$GS_FILE"; then
  say "GAS の「${GS_FILE}」は gas/Code.gs と同じです（新しいバージョンだけ出します）。"
else
  say "GAS の「${GS_FILE}」を gas/Code.gs で置き換えます。"
fi
cat gas/Code.gs >| "$WORK/src/$GS_FILE"

# --- デプロイの説明（git の短い SHA と1行目） ---
DESC='gas-deploy'
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  DESC="$(git log -1 --format='%h %s')"
  if [ -n "$(git status --porcelain -- gas)" ]; then DESC="${DESC}（未コミットの変更あり）"; fi
fi
DESC="${DESC:0:100}"   # 長すぎる説明は切る

say ''
say "  送り先のスクリプト ID: ${SCRIPT_ID}"
say "  差し替えるデプロイ  : ${DEPLOYMENT_ID}"
say "  バージョンの説明    : ${DESC}"
if [ "$CI_MODE" -eq 0 ]; then
  ask_yes '本番に反映しますか？' || { say 'やめました（GAS は何も変わっていません）。'; exit 1; }
fi

say '送っています…'
# -f: マニフェストの確認を出さない（取ったものをそのまま送り返すので中身は変わらない）
( cd "$WORK" && clasp push -f ) || fail "送れませんでした。${hint_api}"

say '新しいバージョンでデプロイしています…'
( cd "$WORK" && clasp deploy -i "$DEPLOYMENT_ID" -d "$DESC" ) \
  || fail "デプロイできませんでした（コードは送ってあります）。デプロイ ID ${DEPLOYMENT_ID} が「デプロイを管理」にあるか確かめてください。"

say ''
say '反映しました。URL は変わりません。確かめ方:'
say "  https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec を開き、{\"ok\":true,...} と出ること"
