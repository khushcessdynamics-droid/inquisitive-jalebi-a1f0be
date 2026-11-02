# Phase 3 report: cloud foundation and multi-user authentication

Date: 2026-11-02. Built and tested against a **local** Supabase stack (same software as Supabase cloud). **Not deployed**, no accounts created.

## Delivered
| Area | What exists |
|---|---|
| Database | 2 SQL migrations: roles, permissions, profiles, per-user overrides, session activity, settings, work categories, Given By names, cancellation reasons, backup-run log, activity log. RLS on every table |
| Business rules | Approved reliability weights (Option 1) stored and validated (must total 100); cancellation reasons classified vendor-caused / not; Excel categories and Given By names preserved |
| Auth | Invitation-only accounts, first-Admin bootstrap, TOTP MFA (mandatory Admin/Manager; required for anyone who enrols), password reset links, server-side session revocation, idle timeout, max session length |
| Permissions | Admin / Manager / Staff matrix as approved; Manager payments view-only; Admin-only `users.manage` / `backups.manage`; per-user exceptions; MFA policy per role |
| Audit | Append-only activity log (update/delete/truncate blocked for all roles), automatic before/after capture with reasons, Supabase sign-in events view |
| Edge Function | `admin-users`: invitation and reset links/emails; uses the secret key server-side only; re-checks the caller's permission; dependency-free |
| Frontend | Login, forgot password, link confirmation, set password, MFA setup/verify, Home with setup checklist, My Account, Users, Roles & Permissions, Settings (8 tabs), Activity History, System Health. Responsive. Strict CSP headers generated at build |

Screenshots of the running app: `docs/screenshots/`.

## Test results (all run on 2026-11-02 in the development container)
| Suite | Result |
|---|---|
| Unit (dates/IST, financial year, settings validation, password policy, permission catalogue vs. SQL) | **20 / 20 passed** |
| Integration, real local Supabase (anonymous access, sign-up disabled, bootstrap, MFA enforcement, invitations, role/permission enforcement via direct API, stale-edit conflict, validation, audit trail, append-only, session revocation, idle timeout, deactivation, last-Admin guard, password reset, voluntary MFA, MFA policy) | **32 / 32 passed** |
| Browser (Playwright): Admin MFA setup, settings change visible in Activity History, invite Staff, Staff accepts link, Staff blocked from Admin pages, link single-use, phone layout | **5 / 5 passed** |
| TypeScript typecheck (shared, web, tests) | Clean |
| Production build | OK (main bundle 188 KB gzipped; admin pages load on demand) |

Example 10 from your test list ("Staff must not access Admin-only settings or unauthorized payment operations; backend must reject direct API calls") is covered by the integration tests. Payment operations themselves arrive in Phase 6.

## Phase 3B: verified backups (added 2026-11-02)
| Item | Result |
|---|---|
| Backup tool `tools/backup` | Consistent snapshot of all app tables, user accounts (incl. MFA) and attachments; AES-256-GCM encrypted; needs only Node.js 22 (no PostgreSQL install) |
| Verification | Test restore into an in-process PostgreSQL (PGlite): counts, keys, relationships, byte-identical re-export, business checks, file checksums |
| Restore | Typed confirmation, re-verification, automatic safety backup, structure-version check, single transaction with checks before commit, activity history never rolled back, attachments re-uploaded |
| Retention | Daily/weekly/monthly; never deletes the newest verified backup or goes below 3 verified backups; files never overwritten |
| Windows | Double-click scripts and a Task Scheduler task that runs missed backups at next start-up (`scripts/windows`) |
| Monitoring | Each run recorded in `backup_runs`; shown on System Health |
| Tests | 14 unit tests (encryption, tampering, wrong key, no-overwrite, retention, config) + 6 integration tests incl. **full disaster recovery** (database wiped, everything restored, Admin signs in with original password and MFA) |

## Not done yet / honest limitations
1. **Backups on your PC:** the hosted-database connection (session pooler + certificate) and the Windows scheduled task can only be confirmed once your Supabase project exists and on your PC.
2. **Not deployed.** Deployment needs your Supabase and Cloudflare accounts (`docs/SETUP_ACCOUNTS.md`). I will not call it live until it is tested over its public HTTPS address.
3. Windows-specific behaviour (backup scheduling) can only be fully verified on your PC.
4. Free-plan limits: no per-account lockout, no leaked-password check, short provider logs (see `docs/SECURITY.md`).
5. Passwords are hashed by Supabase Auth with bcrypt, not Argon2id (not configurable in Supabase).

## Next phases
- **4** Jobs (combined Part No / Part Name, Given By / Created By / Assigned Staff User), Jobs Register, vendors, cancellation & reassignment history, attachments, Excel import/export.
- **5** Commitment history, six-factor reliability score, cost comparison.
- **6** Material returns, quality inspection, payments.
- **7** WhatsApp click-to-chat, reminder engine (pg_cron), notification centre.
- **8** Dashboard, weekly reports (PDF/Excel), report history.
- **9** Deployment (Supabase + Cloudflare), CAPTCHA, production checks from several devices.
- **10** Full testing and handover.
