#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js saknas. Installera Node.js 22.12 eller senare och prova igen."
  read -r -p "Tryck Enter for att stanga."
  exit 1
fi
if ! node scripts/start-demo.mjs; then
  read -r -p "Appen kunde inte starta. Tryck Enter for att stanga."
  exit 1
fi
