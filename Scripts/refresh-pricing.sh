#!/usr/bin/env bash
# Snapshot LiteLLM's model_prices_and_context_window.json into Resources/.
# Run by hand or by CI; the resulting Resources/pricing.json is committed.
set -euo pipefail

URL="https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/pricing.json"

curl -fsSL "$URL" -o "$DEST.tmp"
# Sanity-check: must be valid JSON > 100 KB
test -s "$DEST.tmp"
python3 -c "import json,sys; json.load(open('$DEST.tmp'))" || { rm "$DEST.tmp"; exit 1; }
SIZE=$(wc -c <"$DEST.tmp" | tr -d ' ')
if [ "$SIZE" -lt 102400 ]; then
  echo "refresh-pricing: payload too small ($SIZE bytes), refusing" >&2
  rm "$DEST.tmp"
  exit 1
fi
mv "$DEST.tmp" "$DEST"
echo "refresh-pricing: wrote $DEST ($SIZE bytes)"
