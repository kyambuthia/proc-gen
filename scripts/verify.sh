#!/usr/bin/env bash
# Run every check, then build the web app. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== tests"
node --test tests/*.test.js
echo "== build"
npx vite build --logLevel warn
echo "== ok"
