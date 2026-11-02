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

## Not done yet / honest limitations
1. **Backups (Phase 3B, next):** Supabase Free has no backups. The local Windows backup tool (scheduled export, attachments, verification by test-restore, restore with confirmation, never deleting the only good backup) must be finished **before any real data is entered**. It needs PostgreSQL client tools (free) on your PC.
2. **Not deployed.** Deployment needs your Supabase and Cloudflare accounts (`docs/SETUP_ACCOUNTS.md`). I will not call it live until it is tested over its public HTTPS address.
3. Windows-specific behaviour (backup scheduling) can only be fully verified on your PC.
4. Free-plan limits: no per-account lockout, no leaked-password check, short provider logs (see `docs/SECURITY.md`).
5. Passwords are hashed by Supabase Auth with bcrypt, not Argon2id (not configurable in Supabase).

## Next phases
- **3B** Local verified backup & restore tool (Windows), backup history in System Health.
- **4** Jobs (combined Part No / Part Name, Given By / Created By / Assigned Staff User), Jobs Register, vendors, cancellation & reassignment history, attachments, Excel import/export.
- **5** Commitment history, six-factor reliability score, cost comparison.
- **6** Material returns, quality inspection, payments.
- **7** WhatsApp click-to-chat, reminder engine (pg_cron), notification centre.
- **8** Dashboard, weekly reports (PDF/Excel), report history.
- **9** Deployment (Supabase + Cloudflare), CAPTCHA, production checks from several devices.
- **10** Full testing and handover.
