#!/bin/sh
# One-time setup: SearXNG from source in a uv venv, under the app's data folder.
# The server starts it on the first web search and stops it after 10 idle minutes.
set -e
DATA="${HARNESS_DATA_DIR:-$HOME/Library/Application Support/harness}"
DIR="${SEARXNG_DIR:-$DATA/searxng}"
PORT="${SEARXNG_PORT:-8888}"
mkdir -p "$DATA"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 https://github.com/searxng/searxng.git "$DIR"; fi
cd "$DIR"
[ -x .venv/bin/python ] || uv venv -q -p 3.12 .venv
uv pip install -q -p .venv/bin/python -r requirements.txt
# Our overrides on top of SearXNG's defaults: JSON output on, bound to localhost only.
cat > "$DIR/harness-settings.yml" <<YML
use_default_settings: true
general:
  instance_name: harness
search:
  formats: [html, json]
server:
  bind_address: "127.0.0.1"
  port: $PORT
  limiter: false
  image_proxy: false
  secret_key: "$(openssl rand -hex 16)"
YML
echo "SearXNG ready in $DIR"
