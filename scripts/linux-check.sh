#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
task_dir="${1:-$(mktemp -d "$HOME/agent-workspace-check.XXXXXX")}"
task_node="${WORKSPACE_NODE:-$HOME/.local/bin/node}"
task_pnpm="${WORKSPACE_PNPM_CLI:-/mnt/c/Users/cw125/.npm-global/node_modules/pnpm/bin/pnpm.cjs}"
export PATH="$(dirname "$task_node"):$PATH"
tar -C "$source_dir" --exclude=node_modules --exclude=dist --exclude=release --exclude=evidence --exclude=.git -cf - . | tar -C "$task_dir" -xf -
cd "$task_dir"
printf '%s\n' "$task_dir"
"$task_node" "$task_pnpm" install --frozen-lockfile
"$task_node" "$task_pnpm" build
"$task_node" "$task_pnpm" test
