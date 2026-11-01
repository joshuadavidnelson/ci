#!/usr/bin/env bash
# Measures JS/TS complexity in the current directory and writes ESLint JSON.
#
#   measure.sh <output-file> <npm-script-name> <source-path>...
#
# When package.json has the named npm script (default lint:complexity in
# js.yml), it runs the repo's own ESLint through it:
#
#   npm run <script> -- -f json -o <output> --no-inline-config \
#     --rule 'complexity: [warn, 0]' --rule 'sonarjs/cognitive-complexity: [warn, 0]'
#
# The --rule overrides drop the repo's thresholds to 0 so every function is
# reported with its score (the ceilings are applied afterwards from
# quality-thresholds.json), and --no-inline-config stops eslint-disable
# comments hiding functions. The script's config must register the
# sonarjs plugin under that name.
#
# When the script is missing, or produces no usable output, it falls back
# to the pinned config in this directory over the given source paths, and
# says why in a ::warning:: with ESLint's own error output.
#
# The mode used ("repo" or "builtin") is written to <output-file>.mode.
set -uo pipefail

out="$1"
script="$2"
shift 2
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$(dirname "$out")"
rm -f "$out" "$out.mode"
log="$(mktemp)"

valid() {
	[ -s "$out" ] && node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(Array.isArray(r) ? 0 : 1)' "$out" 2> /dev/null
}

if [ -n "$script" ] && [ -f package.json ] && jq -e --arg s "$script" '.scripts[$s]' package.json > /dev/null; then
	echo "Measuring with the repo's own ESLint config: npm run $script"
	if [ ! -d node_modules ]; then
		npm ci --no-audit --no-fund
	fi
	# Exit status 1 just means lint findings; only the output file matters.
	npm run "$script" -- -f json -o "$out" --no-inline-config \
		--rule 'complexity: [warn, 0]' \
		--rule 'sonarjs/cognitive-complexity: [warn, 0]' 2> >(tee "$log" >&2) || true
	if valid; then
		echo "mode=repo"
		echo repo > "$out.mode"
		exit 0
	fi
	# Annotations are one line: encode newlines, keep the tail of the log.
	detail=$(tail -n 15 "$log" | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
	echo "::warning title=Complexity fell back to the built-in config::npm run $script produced no ESLint JSON, so complexity was measured with the built-in config instead of the repo's. A common cause: the config must register the sonarjs plugin for every file it lints (or ignore other files with a top-level { ignores: [...] }), because js.yml adds a sonarjs/cognitive-complexity rule override. ESLint said:%0A$detail"
fi

paths=()
for p in "$@"; do
	if [ -e "$p" ]; then
		paths+=("$p")
	fi
done
if [ "${#paths[@]}" -eq 0 ]; then
	echo "::notice::None of '$*' exist here, so there is nothing to measure."
	exit 1
fi

echo "Measuring with the built-in complexity config over: ${paths[*]}"
node "$tools/node_modules/eslint/bin/eslint.js" \
	--config "$tools/eslint.config.mjs" \
	--no-error-on-unmatched-pattern --format json \
	--output-file "$out" "${paths[@]}" || true
if valid; then
	echo "mode=builtin"
	echo builtin > "$out.mode"
fi
