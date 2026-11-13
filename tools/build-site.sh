#!/usr/bin/env bash
# Builds the GitHub Pages site:
#   - the current checkout (main) at the root
#   - every other branch on origin under preview/<branch>/
# Run from a checkout of main with all branches fetched:
#   tools/build-site.sh [output-dir]
set -euo pipefail

out="${1:-_site}"
app_files=(index.html manifest.webmanifest icons css js data)

rm -rf "$out"
mkdir -p "$out"
for f in "${app_files[@]}"; do
  if [ -e "$f" ]; then cp -r "$f" "$out/"; fi
done
echo "main -> /"

count=0
while read -r ref; do
  branch="${ref#origin/}"
  case "$branch" in main | HEAD | origin) continue ;; esac
  safe="$(printf '%s' "$branch" | sed 's/[^A-Za-z0-9._-]/-/g')"
  dest="$out/preview/$safe"
  # Only the app files that exist on that branch.
  paths=()
  for f in "${app_files[@]}"; do
    if git cat-file -e "$ref:$f" 2>/dev/null; then paths+=("$f"); fi
  done
  if [ "${#paths[@]}" -eq 0 ]; then continue; fi
  mkdir -p "$dest"
  git archive "$ref" "${paths[@]}" | tar -x -C "$dest"
  echo "$branch -> /preview/$safe/"
  count=$((count + 1))
done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin)

echo "Built $out with $count branch preview(s)"
