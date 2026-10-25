#!/bin/sh
# Auto check-in and push; run by the Stop hook.
cd "$(git rev-parse --show-toplevel)" || exit 0
[ -n "$(git status --porcelain)" ] || exit 0
git add -A
git commit -q -m "harness: autosync $(date -u +%Y-%m-%dT%H:%MZ)"
branch=$(git rev-parse --abbrev-ref HEAD)
for d in 0 2 4 8 16; do
  sleep $d
  git push -q -u origin "$branch" && exit 0
done
exit 0
