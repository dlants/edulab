#!/usr/bin/env bash
# Copy magenta thread archives for this repo into docs/transcripts/.
# Threads are selected by meta.json .cwd matching the repo root, which is a
# superset of "conversation mentions the repo path" and so cannot miss a thread.
# Re-running only copies threads that are new or have grown since the last sync.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src_root="${MAGENTA_THREADS_DIR:-/tmp/magenta/threads}"
dest_root="$repo_root/docs/transcripts"

mkdir -p "$dest_root"

copied=0
for meta in "$src_root"/*/meta.json; do
  [ -e "$meta" ] || continue
  thread_dir="$(dirname "$meta")"
  cwd="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cwd ?? "")' "$meta")"
  [ "$cwd" = "$repo_root" ] || continue
  # -u keeps already-synced threads intact while picking up messages and tool
  # logs appended after the last sync.
  rsync -a -u "$thread_dir" "$dest_root/"
  copied=$((copied + 1))
done

echo "synced $copied thread(s) into $dest_root"
