# Cloud security configuration

The settings each online service must have, why, and how they are checked. Step-by-step setup: `docs/DEPLOYMENT.md`.
Database-level protection: `docs/DATABASE_SECURITY.md`.

## Where each secret lives

| Item | Secret? | Lives only in |
|---|---|---|
| Project URL, publishable key | No (public by design; row security protects the data) | Cloudflare build variables, the website |
| Database password | **Yes** | Your password manager; `backup.json` on the backup PC (inside the connection string); optional GitHub Actions secret `SUPABASE_DB_PASSWORD` |
| Supabase secret key (`sb_secret_…`) | **Yes** | `backup.json` on the backup PC. The Edge Function receives it from Supabase automatically |
| Supabase access token (`sbp_…`) | **Yes** | Optional GitHub Actions secret `SUPABASE_ACCESS_TOKEN` (can be revoked after each deployment) |
| Backup key (`backup.key`) | **Yes** | The backup PC plus one offline copy (USB / printed, locked away) |
| Turnstile secret key (optional) | **Yes** | Supabase → Authentication → Attack Protection |

Never in Git, the website, Cloudflare variables or chat. `.gitignore` excludes `.env*` and backup files; the full Git history was
scanned on 2026-11-03 and contains no key, token or password (`docs/SECURITY_TEST_REPORT.md`, test 14).

## Supabase (Free plan, Mumbai)

| Setting | Value | Why |
|---|---|---|
| Allow new users to sign up | **Off** | Accounts only by Admin invitation |
| Email provider | On, secure password change on | Password sign-in |
| Password rules | At least 12 characters; lower, upper case and digits | Resists guessing |
| Multi-factor (TOTP) | Enabled | Mandatory for Admin and Manager (enforced in the database) |
| Site URL / Redirect URLs | The website address / `<site>/auth/confirm` only | Invitation and reset links cannot be sent to another site |
| Rate limits | Defaults (per address: sign-ins and sign-ups limited per 5 minutes) | Slows password guessing; checked live with `verify.mjs --check-login-limit` |
| CAPTCHA (optional) | Turnstile | Stops automated sign-in attempts |
| Data API | On, `public` schema only; the internal `private` schema is not exposed | Business rules run in the database |
| Storage bucket `job-files` | **Private**, up to 50 MB per file (Settings), only the allowed file extensions (Settings) | Files only through short signed links |
| Edge Function `admin-users` | JWT check off (it checks every caller itself); secrets `APP_SITE_URL`, `APP_ALLOWED_ORIGINS` | Only the website may call it; only an Admin with MFA can use it |
| Account | Two-step sign-in on the Supabase account; no payment card | Whoever controls the account controls all data; no surprise charges |

## Cloudflare Pages (Free)

| Setting | Value | Why |
|---|---|---|
| Source | This GitHub repository, root `machining-tracker`, production branch `main` | Only reviewed code is published |
| Build | `npm ci && npm run build`, output `apps/web/dist`, `NODE_VERSION=22`, `SKIP_DEPENDENCY_INSTALL=1` | Exact locked dependency versions |
| Variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, optional `VITE_TURNSTILE_SITE_KEY` | Public values only |
| Preview branches | None | No second public copy of the app connected to the live data |
| Security headers | From the generated `_headers`: Content-Security-Policy limited to the Supabase project, no framing, HSTS, nosniff, Referrer-Policy, Permissions-Policy | Blocks script injection and click-jacking |
| HTTPS | Automatic on `*.pages.dev` (the `.dev` domain is HTTPS-only in browsers) | Encrypted connections |
| Account | Two-step sign-in on the Cloudflare account | — |

## GitHub

| Setting | Value |
|---|---|
| Repository visibility | **Private recommended** (it is public today; it contains no secrets or business records, but the documentation and the empty Excel template are readable) |
| Actions | `ci.yml` runs on every pull request without secrets; `deploy-supabase.yml` runs only by hand after typing `DEPLOY` |
| Secrets | Only `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`, only if the GitHub deployment route is used |
| Account | Two-step sign-in |

## How the live configuration is checked

`node tools/deploy-check/verify.mjs --site … --supabase … --key …` (`docs/DEPLOYMENT.md`, step 7) confirms from outside: HTTPS and
the security headers, no secret in any JavaScript file, sign-up off, nothing readable without signing in (41 tables and views),
anonymous calls refused, private files, and the Edge Function's origin rules. Add `--check-login-limit` from a network other than the
office to confirm that repeated failed sign-ins are blocked.
