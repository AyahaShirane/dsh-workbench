#!/bin/bash
set -euo pipefail
WORKBENCH_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$WORKBENCH_ROOT"
export DSH_HOME="${DSH_HOME:-$WORKBENCH_ROOT/.dsh-home}"
export DSH_AGENTS_HOME="$DSH_HOME/agents"
export TMPDIR="$WORKBENCH_ROOT/.workbench/tmp"
mkdir -p "$TMPDIR" .workbench/secrets
if [[ -z "${DSH_WORKBENCH_TOKEN:-}" ]]; then
  node --input-type=module -e 'import {existsSync,writeFileSync} from "node:fs";import {randomBytes} from "node:crypto";if(!existsSync(".workbench/secrets/operator-token"))writeFileSync(".workbench/secrets/operator-token",randomBytes(32).toString("hex"),{mode:0o600,flag:"wx"})'
  export DSH_WORKBENCH_TOKEN="$(cat .workbench/secrets/operator-token)"
  echo 'Workbench token: .workbench/secrets/operator-token (paste into the workbench token field)'
fi
if [[ $# -ne 0 ]]; then echo 'Set DSH_WORKBENCH_PORT instead of CLI arguments.' >&2; exit 2; fi
WORKBENCH_PORT="${DSH_WORKBENCH_PORT:-3080}"
[[ "$WORKBENCH_PORT" =~ ^[0-9]+$ ]] && (( WORKBENCH_PORT <= 65535 )) || { echo 'Invalid port' >&2; exit 2; }
node scripts/prepare-profile.mjs
exec node node_modules/@deepseek-ai/dsh/lib/bin.js --profile workbench --host 127.0.0.1 --port "$WORKBENCH_PORT" --no-open
