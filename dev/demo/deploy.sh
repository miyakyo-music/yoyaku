#!/bin/sh
# デモサーバーを作り直して公開する（https://yoyaku-demo.<アカウントのサブドメイン>.workers.dev）。
# Cloudflare のトークンは環境変数 CLOUDFLARE_API_TOKEN、アカウントは CLOUDFLARE_ACCOUNT_ID で渡す。
set -e
cd "$(dirname "$0")"
python3 build.py
npx --yes wrangler@4 deploy
