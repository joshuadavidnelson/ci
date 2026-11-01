# joshuadavidnelson/ci

Shared CI for joshuadavidnelson's PHP and JS repositories. Each repository keeps only thin caller workflows; the jobs, the report renderer and the PR comment live here.

- One sticky PR comment per PR (`ci-report`), merged from report sections: PHP quality, PHP coverage, JS coverage, PHP metrics, JS complexity.
- Coverage floors and gated metrics fail CI by default. Set `enforce: false` to report without failing.
- Fork PRs get comments too, because the comment is posted from a `workflow_run` workflow that never runs PR code.

Callers use the moving `@v1` tag. Releases are semver tags (`v1.0.0`, `v1.1.0`, …), and `v1` moves to the latest v1.x.y.

## Contents

| Path | Kind | What it does |
| --- | --- | --- |
| [`.github/workflows/php-plugin.yml`](.github/workflows/php-plugin.yml) | reusable workflow | Lint matrix → PHPCS/PHPStan/PHPMD → tests with clover coverage, and PHPMetrics. Compares coverage and metrics with the PR's base branch. Uploads report sections. |
| [`.github/workflows/js.yml`](.github/workflows/js.yml) | reusable workflow | JS/TS coverage (`npm run test:coverage`) and complexity (ESLint `complexity` + `sonarjs/cognitive-complexity`), compared with the base branch. Uploads report sections. |
| [`.github/workflows/pr-report.yml`](.github/workflows/pr-report.yml) | reusable workflow | Called from a `workflow_run` workflow. Downloads the sections from the finished run, checks the PR against the API, merges the sections, and posts the one sticky comment. |
| [`.github/workflows/wp-deploy.yml`](.github/workflows/wp-deploy.yml) | reusable workflow | Deploys a tag to WordPress.org SVN after the named CI workflows passed on it, behind an environment approval. |
| [`.github/workflows/wp-readme-deploy.yml`](.github/workflows/wp-readme-deploy.yml) | reusable workflow | Syncs `readme.txt` and `.wordpress-org/` assets to SVN trunk. |
| [`actions/setup-php`](actions/setup-php/action.yml) | composite action | Installs PHP, restores the Composer cache and runs `composer install`. For a repo's own ad-hoc workflows. |
| [`actions/render-report`](actions/render-report/action.yml) | Node action | Builds section JSON from clover / json-summary / PHPMetrics / ESLint output, enforces section status, and merges sections into the comment. |
| [`tools/js-complexity`](tools/js-complexity) | npm package | The pinned ESLint toolchain `js.yml` measures complexity with. |
| [`workflow-templates/`](workflow-templates) | templates | Caller workflows to copy into `joshuadavidnelson/.github` so they show up under "New workflow". |
| [`examples/quality-thresholds.json`](examples/quality-thresholds.json) | example | The thresholds file schema, with archived-post-status's numbers. |
| [`test/fixtures/`](test/fixtures) | fixtures | A PHP plugin and a JS package the self-test runs the reusable workflows against. |

## The repo contract

A repository that calls these workflows provides the following.

### Composer scripts (PHP)

| Script | Used by | Required |
| --- | --- | --- |
| `lint` | lint matrix | yes |
| `phpcs` | quality | yes |
| `phpstan` | quality | yes |
| `phpmd` | quality | no: skipped when the script is absent |
| `phpunit` | tests, when `coverage: false` | when `coverage: false` and the repo has a suite |
| `phpunit:coverage-clover` | tests, when `coverage: true`; must write `coverage/php-clover.xml` | when `coverage: true` and the repo has a suite |
| `phpmetrics-summary` | metrics; must write `reports/metrics-summary.json` | when `metrics: true` |

A repo without a suite yet (no `phpunit.xml` / `phpunit.xml.dist`, or no script for the mode in use) gets its tests job skipped with a notice, or a warning when `coverage: true`, since the floors then go unchecked. `tests: false` skips the job explicitly. The coverage job installs Xdebug. If the script sets `-dxdebug.mode=coverage` (as archived-post-status does), nothing else is needed. The PHPMetrics `phpmetrics-summary` script should measure the same directories as the `source-paths` input, because `source-paths` is what the base branch is measured over.

### npm scripts (JS, only if the repo calls `js.yml`)

| Script | Must write |
| --- | --- |
| `test:coverage` | `coverage/coverage-summary.json` (istanbul `json-summary`: Jest `--coverage --coverageReporters=json-summary`, or Vitest `coverage.reporter: ['json-summary']`) |
| `lint:complexity` (optional; name set by the `complexity-script` input) | Runs the repo's own ESLint over its JS, e.g. `"eslint assets/js"`, with a flat `eslint.config.js` that registers `eslint-plugin-sonarjs` as `sonarjs`. |

`js.yml` runs `npm ci`, so commit `package-lock.json`.

Complexity runs `npm run lint:complexity -- -f json -o <file> --no-inline-config --rule 'complexity: [warn, 0]' --rule 'sonarjs/cognitive-complexity: [warn, 0]'`. The rule overrides set the thresholds to 0 so every function is reported with its score, and the ceilings from `quality-thresholds.json` are applied afterwards. Your config can read the same ceilings from `quality-thresholds.json`, so `npm run lint:complexity` fails locally on the numbers CI gates on (see [the JS fixture](test/fixtures/js-package/eslint.config.js)). **The config must register the sonarjs plugin for every file it lints**, because the `sonarjs/cognitive-complexity` override applies to all of them. Files the sonarjs block should not cover (tests, say) must be ignored globally with a top-level `{ ignores: [ '**/*.test.js' ] }` object, not with `ignores` inside the sonarjs block; otherwise ESLint aborts with "could not find plugin sonarjs". Without the script, or if it produces no ESLint JSON, js.yml falls back to this repository's pinned ESLint and [config](tools/js-complexity/eslint.config.mjs) over `js-source-paths`. A fallback after the script failed raises a "Complexity fell back to the built-in config" warning that includes ESLint's error output, and the section says which config measured it.

### `quality-thresholds.json`

At the root of the working directory. The schema is archived-post-status's, plus an optional `js.complexity` block:

```json
{
  "coverage": {
    "php": { "lines": 90, "methods": 90 },
    "js": { "statements": 95, "branches": 90, "functions": 95, "lines": 95 }
  },
  "metrics": {
    "max": {
      "critical": 0,
      "error": 0,
      "avgCyclomaticComplexityByClass": 8,
      "logicalLinesByMethod": 12,
      "lackCohesionOfMethods": 3.5,
      "avgEfferentCoupling": 4
    },
    "gate": [ "critical", "error" ]
  },
  "js": {
    "complexity": { "cyclomatic": 10, "cognitive": 15 }
  }
}
```

- `coverage.php` keys: `lines`, `methods`, `branches`. `coverage.js` keys: `statements`, `branches`, `functions`, `lines`. Every floor fails CI when breached (with `enforce: true`). A metric that was not measured (PHP branches under Xdebug, for example) never fails.
- `metrics.max` lists the PHPMetrics values the report shows. Each is a ceiling. Supported keys: `critical`, `error`, `avgCyclomaticComplexityByClass`, `logicalLinesByMethod`, `lackCohesionOfMethods`, `avgEfferentCoupling`. Keys in `metrics.gate` fail CI when breached; the rest only mark the comment with ❌.
- Any block can be left out. `php-plugin.yml` reads only `coverage.php` and `metrics`, and `js.yml` reads only `coverage.js` and `js.complexity`, so a PHP-only repo needs no `js` keys.
- `metrics.gate` compares each gated key against its own `metrics.max` ceiling, so a gate can be a non-zero ratchet (`"error": 4`).
- `js.complexity` holds per-function ceilings: `{ "cyclomatic": 10, "cognitive": 15 }`. Every key given is gated: the job fails when the worst function exceeds it. To report a ceiling without gating it, use the long form `{ "max": { "cyclomatic": 10, "cognitive": 15 }, "gate": [ "cognitive" ] }`. With no block, the defaults (10 and 15) are reported and nothing is gated.
- An unknown key is an error, not silently ignored, so a typo cannot quietly turn a gate off.
- With `enforce: true` the file must exist; the job fails if it is missing.

## Callers

### `.github/workflows/integrate.yml`

```yaml
name: "Integrate"

on:
  pull_request: null
  push:
    branches:
      - stable
      - develop

permissions:
  contents: read

concurrency:
  group: "${{ github.workflow }}-${{ github.ref }}"
  cancel-in-progress: true

jobs:
  php:
    uses: joshuadavidnelson/ci/.github/workflows/php-plugin.yml@v1
    with:
      php-versions: '["8.2", "8.3", "8.4", "8.5"]'
      source-paths: "src/"

  # Only if the repository has JS.
  js:
    uses: joshuadavidnelson/ci/.github/workflows/js.yml@v1
    with:
      js-source-paths: "assets/js/"
```

Keep the workflow `name:` as `Integrate`: the PR report caller and the deploy workflow refer to it by name. Repo-specific jobs (plugin check, `.pot` freshness, integration tests against WordPress) stay in this file beside the two `uses:` jobs.

### `.github/workflows/pr-report.yml`

```yaml
name: "PR Report"

on:
  workflow_run:
    workflows: [Integrate]
    types: [completed]

permissions:
  pull-requests: write
  actions: read

jobs:
  report:
    uses: joshuadavidnelson/ci/.github/workflows/pr-report.yml@v1
```

`workflow_run` only fires from the default branch (`stable`), so **the comment appears only once this file has merged to stable**. Until then PRs run CI and upload sections, but nothing comments.

### Deploys

```yaml
# .github/workflows/deploy.yml
name: "Deploy to WordPress.org"
on:
  push:
    tags:
      - "[0-9]+.[0-9]+.[0-9]+"
      - "[0-9]+.[0-9]+.[0-9]+.[0-9]+"
permissions:
  contents: read
jobs:
  deploy:
    uses: joshuadavidnelson/ci/.github/workflows/wp-deploy.yml@v1
    permissions:
      actions: read
      contents: read
    with:
      slug: "archived-post-status"
      required-workflows: |
        Integrate
        Unit Tests
        WP Plugin Check
    secrets: inherit
```

```yaml
# .github/workflows/deploy-readme.yml
name: "Plugin asset/readme update"
on:
  push:
    branches: [stable]
    paths: ["readme.txt", ".wordpress-org/**"]
permissions:
  contents: read
jobs:
  trunk:
    uses: joshuadavidnelson/ci/.github/workflows/wp-readme-deploy.yml@v1
    with:
      slug: "archived-post-status"
    secrets:
      SVN_USERNAME: ${{ secrets.SVN_USERNAME }}
      SVN_PASSWORD: ${{ secrets.SVN_PASSWORD }}
```

`wp-deploy.yml` runs its deploy job in the `wordpress-org` environment (input `environment`). Give that environment a required reviewer **before the first tag**: if it does not exist, GitHub creates it on the first run with no protection rules, so that deploy goes straight to SVN without waiting for approval (the verify job's green-CI check still applies). An auto-created environment also has no environment secrets, so the SVN credentials must then come from repository secrets via `secrets: inherit`. The SVN secrets can be repository secrets passed with `secrets: inherit` or environment secrets on `wordpress-org`; the environment's take precedence.

## Inputs

### `php-plugin.yml`

| Input | Default | |
| --- | --- | --- |
| `php-versions` | `'["8.2", "8.3", "8.4", "8.5"]'` | JSON array for the lint matrix. |
| `lint-standalone` | `false` | Lint with a standalone php-parallel-lint over `lint-paths`, without the project's dependencies (see below). |
| `lint-paths` | `"."` | Paths for the standalone lint. |
| `lint-composer-args` | `""` | Extra `composer install` arguments for the lint matrix only. |
| `quality-php-version` | `"8.4"` | PHP for quality, tests/coverage and metrics. |
| `source-paths` | `"src/"` | Space-separated, relative to `working-directory`. The base branch's PHPMetrics run measures these. |
| `tests` | `true` | Run the PHPUnit job. It also skips itself when there is no suite (see the contract). |
| `coverage` | `true` | Run `phpunit:coverage-clover` and report coverage. `false` runs `phpunit` instead. |
| `metrics` | `true` | Run PHPMetrics on head and base. |
| `enforce` | `true` | Fail on breached coverage floors and gated metrics. |
| `thresholds-file` | `"quality-thresholds.json"` | Relative to `working-directory`. |
| `working-directory` | `"."` | Directory holding `composer.json`. |
| `ci-ref` | `"v1"` | Ref of this repo to load the report scripts from (see below). |

Older PHP in the lint matrix: setup-php and php-parallel-lint 1.x both run on PHP 7.4, so `php-versions: '["7.4", "8.0", "8.4"]'` works if `composer install` succeeds on every version, i.e. the lock (or `config.platform.php`) targets the oldest version. If the lock pins dev tools that need newer PHP (PHPUnit 10+, PHPStan 2), set `lint-standalone: true`: each lint leg then installs php-parallel-lint on its own and runs it over `lint-paths` (default `.`, excluding `vendor/` and `node_modules/`) instead of `composer run lint`. `lint-composer-args: "--ignore-platform-reqs"` is **not** enough on its own: parallel-lint loads the project's `vendor/autoload.php`, and PHPUnit 11's autoloaded `Functions.php` does not parse on 7.4 (the self-test hit exactly this). The self-test lints its fixture on 7.4 with `lint-standalone`.

Jobs: `lint` (matrix) → `quality` → `tests` and `metrics` in parallel, plus `report-meta` (PRs only, no `needs`, so even a lint failure gets a comment saying so). Everything runs with `contents: read`.

### `js.yml`

| Input | Default | |
| --- | --- | --- |
| `node-version` | `"lts/*"` | For the repo's tests. |
| `node-cache` | `"npm"` | `actions/setup-node` cache type; `""` disables it. |
| `js-source-paths` | `"src/"` | Space-separated paths the built-in complexity config measures (and the base fallback). |
| `complexity-script` | `"lint:complexity"` | npm script that runs the repo's own ESLint. `""` always uses the built-in config. |
| `coverage` | `true` | Run `npm run test:coverage`. |
| `complexity` | `true` | Measure complexity with ESLint. |
| `enforce` | `true` | Fail on breached coverage floors and gated complexity. |
| `thresholds-file` | `"quality-thresholds.json"` | Relative to `working-directory`. |
| `working-directory` | `"."` | Directory holding `package.json`. |
| `ci-ref` | `"v1"` | As above. |

### `pr-report.yml`

| Input | Default | |
| --- | --- | --- |
| `run-id` | the triggering `workflow_run` | The CI run to report on. |
| `ci-ref` | `"v1"` | Ref of this repo to load the renderer from. |

The caller grants `pull-requests: write` and `actions: read`. No secrets.

### `wp-deploy.yml`, `wp-readme-deploy.yml`

- `wp-deploy.yml`: `slug` (required), `required-workflows` (newline list, default `Integrate`), `environment` (default `wordpress-org`), `build-dir`, `dry-run`. Secrets `SVN_USERNAME`, `SVN_PASSWORD`. `required-workflows` can only list workflows that run on the tagged commit itself, which in practice means workflows triggered by `push` to the branch you tag from. A PR-only workflow (E2E on `pull_request`, say) never runs on that commit, so listing it would block every deploy with "never ran on this commit".
- `wp-readme-deploy.yml`: `slug` (required), `assets-dir` (default `.wordpress-org`), `ignore-other-files` (default `true`). Secrets `SVN_USERNAME`, `SVN_PASSWORD` (required).

### `ci-ref`

A reusable workflow cannot find out which ref of its own repository it was called at, so the jobs fetch this repository's scripts at `ci-ref` (default `v1`). With `@v1` on the `uses:` line nothing needs setting. If you pin `uses: …@v1.2.0`, also pass `ci-ref: v1.2.0` so the scripts match the workflow.

## Opting out of enforcement

Enforcement is on by default: a coverage floor breach, a gated PHPMetrics value over its ceiling, or (if gated) JS complexity over its ceiling fails the job. To keep the report but never fail on numbers:

```yaml
jobs:
  php:
    uses: joshuadavidnelson/ci/.github/workflows/php-plugin.yml@v1
    with:
      enforce: false
  js:
    uses: joshuadavidnelson/ci/.github/workflows/js.yml@v1
    with:
      enforce: false
```

Finer-grained options: drop a key from `coverage.php` / `coverage.js` to stop gating it, remove a key from `metrics.gate` to report it without failing, or leave out `js.complexity.gate`. Failing tests, lint, PHPCS, PHPStan and PHPMD always fail CI; `enforce` only covers the numeric thresholds.

## Report sections

Every reporting job uploads an artifact named `report-section-<id>` holding one JSON file:

```json
{
  "id": "php-coverage",
  "title": "PHP coverage",
  "status": "pass",
  "baseline": true,
  "markdown": "| Suite | Metric | Base | PR | Δ | Floor |\n…",
  "failures": []
}
```

- `id` matches `^[a-z0-9][a-z0-9-]{0,62}$` and must equal the artifact name's suffix.
- `status` is `pass`, `warn` (nothing failed, but something moved the wrong way or breached an ungated ceiling) or `fail`.
- The body is either `markdown` or `rows`: `{ "columns": [...], "rows": [[...]], "align": ["left", "right", ...] }`, with an optional one-line `summary` above the table.
- `baseline: true` means the section compared against the base branch; the comment only shows "base → PR" if some section did.
- `failures` are the messages the `enforce` step prints. They are never rendered.

The ids this repo emits, in display order: `php-quality`, `php-coverage`, `js-coverage`, `php-metrics`, `js-complexity`. Any other id is merged too, after these, alphabetically, so a repo can add its own section from its own job:

```yaml
- run: |
    mkdir -p "$RUNNER_TEMP/s"
    jq -n --arg md "$(cat my-report.md)" \
      '{ id: "plugin-check", title: "Plugin Check", status: "pass", markdown: $md }' > "$RUNNER_TEMP/s/plugin-check.json"
- uses: actions/upload-artifact@v7
  with:
    name: report-section-plugin-check
    path: ${{ runner.temp }}/s/plugin-check.json
```

`php-plugin.yml` also uploads `report-meta` and `js.yml` uploads `report-meta-js`: `{ pr_number, head_sha, base_sha, run_url }`. `pr-report.yml` accepts any `report-meta*` artifacts as long as they agree on the PR number.

### What `pr-report.yml` trusts

The sections come from a `pull_request` run, and a fork can edit the workflow that produced them. So the report job:

- never checks out or runs the PR's code; the only code it runs is this repository at `ci-ref`;
- takes the run's head SHA, name, URL and conclusion from the API, not from artifacts;
- uses `report-meta`'s PR number only as a pointer: the PR's `head.sha` must equal the run's `head_sha`, the PR must target this repository and be open, or nothing is posted;
- caps artifact count (25) and size (256 KiB zipped and unzipped, 5 files, flat names) before extracting, caps each section file at 64 KiB, and validates every section's shape;
- escapes everything it renders: raw HTML is entity-escaped, image syntax is disabled, `@`-mentions are broken with a zero-width joiner, table cells cannot break out of their row, headings are demoted below the comment's own, and the comment stays under GitHub's size limit by dropping whole sections;
- needs no secrets.

## Adopting

For a repository moving onto this CI (archived-post-status, disable-blog, scripts-to-footer, …):

1. **Contract.** Make sure the composer scripts in [the repo contract](#the-repo-contract) exist. `phpunit:coverage-clover` must write `coverage/php-clover.xml` and `phpmetrics-summary` must write `reports/metrics-summary.json`. If the repo has JS, `test:coverage` must write `coverage/coverage-summary.json` and `package-lock.json` must be committed.
2. **Thresholds.** Add `quality-thresholds.json` at the repo root ([schema](#quality-thresholdsjson)). Set floors a few points under the current numbers. Without the file, enforcement fails the job; add it or set `enforce: false`.
3. **Integrate.** Replace the code-analysis, coverage and report jobs in `.github/workflows/integrate.yml` with the `php` (and `js`) jobs from [the caller example](#githubworkflowsintegrateyml). Keep the workflow name `Integrate`. Keep repo-specific jobs (plugin check, `.pot` freshness, WordPress integration tests) in the same file.
4. **PR report.** Add `.github/workflows/pr-report.yml` from [the caller example](#githubworkflowspr-reportyml). It only runs once merged to the default branch (`stable`).
5. **Delete the copies.** Remove `.github/actions/setup-php-composer`, `.github/scripts/{coverage,check-coverage,render-pr-report}.js` and their tests and Jest config, and the `test:workflows` npm script if nothing else uses it. If another workflow in the repo still used the local `setup-php-composer` action, point it at `joshuadavidnelson/ci/actions/setup-php@v1` (inputs `php-version`, `coverage`, `working-directory`).
6. **Deploys (optional).** Replace `deploy.yml` and `deploy-readme.yml` with the [callers above](#deploys), passing the plugin `slug` and, for `wp-deploy.yml`, the names of every workflow that must be green on a tag in `required-workflows`.
7. **No CS-fixer workflow.** Delete `cs-fixer.yaml`. There is deliberately no shared replacement: a PR with coding-standards violations fails the PHPCS check, and the author fixes it locally with the repo's composer tooling (e.g. `composer phpcbf`).
8. **Check it.** Open a PR. CI should show the `php / …` (and `js / …`) jobs. After the PR report caller is on `stable`, each PR gets one comment headed "📊 PR Report", updated in place on every push.

Things that differ from the per-repo copies:

- The comment's sticky header is `ci-report`, not `pr-report`, so the first run after adopting posts a new comment; the old `pr-report` comment on an open PR is left behind and can be deleted.
- The comment comes from the `PR Report` workflow (`workflow_run`), not from a job in Integrate, and so only appears after `pr-report.yml` is on `stable`.
- Base measurement tolerates a base branch without the scripts: the Base and Δ columns disappear and the section says so.
- The coverage, metrics and complexity sections are uploaded even when tests or a gate fail, so a failing PR still gets its numbers.
- `quality-thresholds.json` must exist when `enforce` is true.
- JS complexity is new. Add `js.complexity` ceilings to gate it, or leave the block out to keep it report-only. With a `lint:complexity` npm script, your own `eslint.config.js` is used.

## Deviations from the shared spec

- **`ci-ref` input.** Every reusable workflow except the deploy ones has a `ci-ref` input (default `v1`), because a reusable workflow cannot resolve its own ref to load scripts from. With `@v1` callers need not set it.
- **`report-meta-js`.** `js.yml` uploads its metadata as `report-meta-js`, not `report-meta`, so a caller using both workflows in one run does not upload two artifacts with the same name. `pr-report.yml` reads every `report-meta*` artifact and requires them to agree.
- **No bundling for `actions/render-report`.** It uses Node built-ins only, so `index.js` runs as-is (`using: node24`) with no `dist/` bundle to rebuild. The reusable workflows run the same file with `node … index.js <command>` from a fetch of this repo at `ci-ref`, not via `uses:`.
- **Setup steps inlined.** The reusable workflows inline the three `actions/setup-php` steps instead of calling the action, for the same reason as `ci-ref`. The cache key also includes the PHP version, so repos that do not pin `config.platform.php` are safe.
- **No `cs-fixer.yml`.** The spec listed a reusable CS-fixer workflow; it is intentionally not provided. Coding-standards violations fail the PHPCS check in CI and are fixed locally with each repo's composer scripts.
- **`php-quality` section.** The quality job also uploads a `php-quality` section (PHPCS / PHPStan / PHPMD outcomes), which the spec did not list.
- **Lint options.** `lint-standalone` / `lint-paths` lint without the project's dependencies, for PHP older than the lock's dev tools; `lint-composer-args` passes extra `composer install` arguments.
- **`js.complexity` long form.** Besides the flat `{ "cyclomatic": n, "cognitive": n }` ceilings (all gated), the `{ max, gate }` form is accepted, so a ceiling can be reported without failing CI.
- **Sections on every event.** Sections are uploaded on push runs too (cheap, and the self-test merges them); `report-meta` is uploaded only for PRs, so `pr-report.yml` has nothing to post for pushes.

## Developing

```sh
npm ci
npm test                         # Jest suite for actions/render-report
node actions/render-report/index.js php-coverage --head clover.xml --output s.json
```

The Self-test workflow runs actionlint, the Jest suite, and `php-plugin.yml` / `js.yml` against `test/fixtures/php-plugin` and `test/fixtures/js-package` using the scripts from the commit under test (`ci-ref: ${{ github.sha }}`), then merges the uploaded sections and requires every one to pass. On a PR, `self-test-report.yml` posts the report through `pr-report.yml`, exercising the whole `workflow_run` path.

To release: merge to `main` with Self-test green, then tag `vX.Y.Z` and move `v1`:

```sh
git tag -a v1.2.0 -m "v1.2.0"
git tag -f -a v1 -m "v1 → v1.2.0"
git push origin v1.2.0
git push -f origin v1
```

## Licence

GPL-2.0-or-later, the same as the plugins. See [LICENSE](LICENSE).
