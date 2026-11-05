# Dependency vulnerability report

Checked on 2026-11-03 with `npm audit` (npm advisory database) on the locked versions in `package-lock.json`.

| Severity | App dependencies (`npm audit --omit=dev`) | All dependencies incl. build and test tools |
|---|:-:|:-:|
| Critical | 0 | 0 |
| High | 0 | 0 |
| Moderate | 9 | 9 (the same ones) |
| Low | 0 | 0 |

**Automatic check:** every pull request runs `npm audit --omit=dev --audit-level=high` in GitHub Actions
(`.github/workflows/ci.yml`), so a new high or critical vulnerability in the app's dependencies stops the build.

## The 9 moderate findings: all inside `exceljs`, none reachable

`exceljs` 4.4.0 (the newest version) reads and writes the Excel files. All nine findings are libraries it depends on:

| Package | Advisory | Why it does not affect this app |
|---|---|---|
| `uuid` < 11.1.1 | Missing buffer bounds check in `v3`/`v5`/`v6` when a `buf` argument is passed (GHSA-w5hq-g745-h8pq) | exceljs only calls `uuid.v4()` without a buffer, to name conditional-formatting rules (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`). The affected functions are never called |
| `minimatch` (via `glob`, `rimraf`, `readdir-glob`, `archiver-utils`, `archiver`, `zip-stream`) | Denial of service through crafted glob patterns | These are used only by exceljs's Node.js file-streaming writer, with patterns written in exceljs's own code, never with user input. The browser copy of exceljs that the website loads (`dist/exceljs.min.js`) does not contain `minimatch`, `glob`, `archiver`, `readdir-glob` or `rimraf` at all (checked in the production build); it zips with JSZip |
| `exceljs` itself | Listed only because of the packages above | — |

`npm audit fix --force` would "fix" these by downgrading to exceljs 3.4.0, an old version with a different API that would break the
Excel import and export. That is not applied. When exceljs publishes a release with updated dependencies, update it and re-run this
check.

## How to re-check

```bash
npm audit --omit=dev
```
```bash
npm audit
```
