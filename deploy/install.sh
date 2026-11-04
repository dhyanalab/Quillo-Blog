#!/bin/bash
# Installs Quillo as a service on Debian, Ubuntu or Raspberry Pi OS, from the project folder copied to the server.
#   bash deploy/install.sh https://blog.example.com
# Optional: PORT=4200 (default 4100), QUILLO_SERVICE=myblog (default quillo, for a second blog on the same machine).
set -e
SITE_URL="${1:?Usage: bash deploy/install.sh https://your-blog-address}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${QUILLO_SERVICE:-quillo}"
PORT="${PORT:-4100}"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Install Node 22.13 or newer first."; exit 1; }

cd "$APP_DIR"
echo "== Installing packages (a minute or two) =="
npm ci --omit=dev --no-audit --no-fund
mkdir -p data && chmod 700 data
[ -f data/secret.key ] && chmod 600 data/secret.key
if ss -ltn | grep -q ":$PORT "; then echo "Port $PORT is already in use. Run again with PORT=<a free port>."; exit 1; fi

sudo tee "/etc/$NAME.env" >/dev/null <<ENV
HOST=127.0.0.1
PORT=$PORT
SITE_URL=$SITE_URL
TRUST_PROXY=1
PROXY_HOPS=1
ENV
sudo chmod 600 "/etc/$NAME.env"
sed -e "s|@USER@|$USER|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE@|$NODE|g" -e "s|@ENV_FILE@|/etc/$NAME.env|g" \
  deploy/quillo.service | sudo tee "/etc/systemd/system/$NAME.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now "$NAME"
sleep 4

echo "== Result =="
echo "Blog answers with: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/") (200 = OK)"
echo "A new blog prints its setup link and setup token below; open the link on your public address once it is connected."
sudo journalctl -u "$NAME" -n 15 --no-pager
