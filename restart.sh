#!/usr/bin/env bash
# Stop the systemd service, pull the latest, reinstall/rebuild, and start again.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

echo "==> Stopping hermesnotes…"
sudo systemctl stop hermesnotes || true

echo "==> Pulling latest…"
git pull --ff-only

echo "==> Installing dependencies…"
pnpm install

echo "==> Applying database migrations…"
pnpm db:migrate

echo "==> Building…"
pnpm build

echo "==> Starting hermesnotes…"
sudo systemctl start hermesnotes
sleep 1
sudo systemctl status hermesnotes --no-pager
