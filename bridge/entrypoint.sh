#!/bin/bash
set -e

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
export OPENCLAW_HOME

node /app/dist/init.js

if [ -n "$FRAMECLAW_PROXY__URL" ]; then
  echo "[entrypoint] Platform mode detected"
  echo "[entrypoint] Proxy URL: $FRAMECLAW_PROXY__URL"
  echo "[entrypoint] Model: $FRAMECLAW_AGENTS__DEFAULTS__MODEL"
fi

exec "$@"
