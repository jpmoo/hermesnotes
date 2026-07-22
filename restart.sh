#!/usr/bin/env bash
# Stop the systemd service, pull the latest, reinstall/rebuild, and start again.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

echo "==> Stopping hermesnotes…"
sudo systemctl stop hermesnotes || true
# MCP server (optional unit — see docs/hermes-mcp.service).
sudo systemctl stop hermes-mcp 2>/dev/null || true

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
if systemctl list-unit-files hermes-mcp.service >/dev/null 2>&1 && \
   systemctl list-unit-files hermes-mcp.service | grep -q hermes-mcp; then
  echo "==> Starting hermes-mcp…"
  sudo systemctl start hermes-mcp
fi
sleep 1
sudo systemctl status hermesnotes --no-pager
