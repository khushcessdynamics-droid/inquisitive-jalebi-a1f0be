# Security testing report

Run on 2026-11-03 against the local Supabase stack (the same migrations, policies and functions the live project gets), plus GitHub
Actions on every pull request. **Items that can only be proven on the live site are marked "Live" and are checked with
`tools/deploy-check/verify.mjs` after deployment (`docs/DEPLOYMENT.md`, step 7). The application is not deployed yet, so they are
still open.**

Test files: `tests/integration/*.test.ts` (real API and database), `tests/e2e/*.spec.ts` (browser), `tests/prod/production.spec.ts`
(production build served like Cloudflare), `apps/web/src/lib/errors.test.ts` (error messages).

## Final security acceptance tests (requirement 13)

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Unauthorized users cannot access restricted pages or APIs | **Pass** | foundation: "cannot read any table or call RPCs", "cannot sign up", "a user created outside the invitation flow has no access", "an Admin without MFA (aal1) is blocked from all data". phase10 e2e: every page opened as Admin, Manager and Staff shows "No access" exactly where the role lacks the permission. `verify.mjs` repeats the anonymous checks against the live project (41 tables and views) |
| 2 | Staff cannot perform Admin-only operations | **Pass** | foundation: "Staff cannot change settings, master data, users or read the audit history via direct API calls", "Staff cannot use the Edge Function". phase5/phase6/jobs: server-side refusals for revisions, reliability, quotations, returns, payments, imports |
| 3 | Deactivated users cannot continue using existing sessions | **Pass** | foundation: "deactivation blocks a signed-in user at once and prevents new sign-ins; history is kept", "'log out everywhere' invalidates an existing access token immediately", "the server-side idle timeout ends inactive sessions" |
| 4 | Repeated failed logins trigger the configured protection | **Live** | The limit (per address, per 5 minutes) is applied by Supabase's hosted platform; the local stack has none (170 wrong passwords in a row were all answered, measured). `verify.mjs --check-login-limit` checks it on the live project. The sign-in page's message is tested (phase10 e2e "repeated failed sign-ins: the sign-in page explains the block"). Optional Turnstile CAPTCHA tested (prod). MFA protects Admin and Manager even if a password is guessed |
| 5 | Passwords are never stored in plain text | **Pass** | phase10-security: "passwords are stored only as salted bcrypt hashes" (format check, different salt for the same password, no copy in application tables). Backups holding the hashes are encrypted (backup: "creates an encrypted backup …") |
| 6 | Uploaded files cannot be accessed through public URLs | **Pass** | phase10-security: "attachments have no public URL, need a signed link …" (public URL, anonymous and publishable-key requests refused; bucket private). jobs: "the job's staff can upload, list and download; others cannot", "blocks disallowed file types, registering someone else's file, overwriting and deleting" |
| 7 | Expired signed file links no longer work | **Pass** | phase10-security: a 2-second link works, then fails after expiry. The app creates 60-second links |
| 8 | Database credentials are not exposed in frontend code | **Pass** (build) / **Live** | CI scans every production build for secret keys and connection strings; `verify.mjs` scans every JavaScript file of the live site, including decoding tokens for the `service_role` role. Tested: it catches a planted secret |
| 9 | HTTPS works correctly | **Live** | `verify.mjs`: HTTPS, http→https, HSTS. Security headers tested on the production build (prod: "security headers, caching and single-page routing") |
| 10 | Backup and restore work successfully | **Pass** | phase10-restore (Example 11): complete business records backed up, verified with business checks, whole database lost, restored; everything the app shows is identical; protections and numbering continue. backup: damaged file / wrong key refused, confirmation required, structure mismatch refused, same-project restore with safety backup |
| 11 | Multiple users cannot accidentally overwrite each other's changes | **Pass** | phase10-security: simultaneous saves on different jobs both persist; on the same job exactly one wins and the other gets "changed by someone else". phase10 e2e: two tabs; the other tab is warned at once, keeps its typing, and its save is refused. foundation/jobs: stale edits of settings and jobs detected |
| 12 | Payment history cannot be silently altered | **Pass** | phase6: "a payment is never edited or deleted: a reversal with a reason is added instead", "history cannot be edited or deleted, not even by the database owner". phase10-restore: still true after a restore |
| 13 | Audit records are retained | **Pass** | foundation: "the activity history is append-only, even for the service role and the database owner", "records who changed what, with previous and new values". backup: the restore never rolls the history back |
| 14 | Production secrets are not committed to source control | **Pass** | All 20 commits of the repository history scanned on 2026-11-03 for Supabase secret keys, access tokens, `service_role` tokens, connection strings with passwords, private keys and cloud tokens: none. The only matches were a documentation placeholder, a fake password in a test of log redaction, and base64 image data. `.env` files are ignored; only `.env.example` (no values) is committed |
| 15 | Application errors do not expose confidential information | **Pass** | errors.test: raw database messages (table, column, constraint, function names) are replaced by a plain message with an error code; the app's own messages stay readable. A crash shows a plain "This page could not be displayed" screen. phase10 e2e: no page shows an error or a failed request for any role. The Edge Function returns plain messages and never logs links or secrets |

## Business rule examples (requirement 29)

| # | Example | Result | Evidence |
|---|---|---|---|
| 1 | Job delay from the current date and time | **Pass** | jobs: "calculates Draft, Commitment Date Missing, Due Today and Overdue from real dates" |
| 2 | Commitment revision keeps both dates and history | **Pass** | phase5: "original 05-Nov, revised to 08-Nov …"; e2e phase5 Example 2 |
| 3 | 100 sent, 60 returned, 40 pending | **Pass** | phase6; e2e phase6 Examples 3 and 4 |
| 4 | 60 returned, 55 accepted, 5 rejected, shown separately | **Pass** | phase6; e2e phase6 |
| 5 | Invoice ₹50,000, payments ₹20,000 + ₹15,000, balance ₹15,000 | **Pass** | phase6: "invoice ₹50,000; payments …"; e2e phase6 Example 5 |
| 6 | Three quotes: lowest, highest, average, % difference | **Pass** | phase5; e2e phase5 Example 6 |
| 7 | Reliability from eligible records, sample size and formulas shown | **Pass** | phase5 (five tests); e2e phase5 Example 7 |
| 8 | Cancel Vendor A, assign Vendor B, both kept | **Pass** | jobs: "keeps both vendor assignments in the same job history (Example 8)"; e2e jobs |
| 9 | Two users at the same time; conflicts handled safely | **Pass** | phase10-security (simultaneous saves); e2e phase10 (two tabs) |
| 10 | Staff blocked from Admin settings and payment operations, also via the API | **Pass** | foundation; phase6: "Managers can view payments but not add, reverse or change amounts; Staff see nothing" |
| 11 | Backup, restore to a test environment, records consistent | **Pass** | phase10-restore; the backup tool's own verification restores every backup into a separate test database before marking it verified |

## Phase 10 checklist

| Item | Result | Evidence |
|---|---|---|
| Every form and button | **Pass** | Every form is exercised by the browser tests of its phase; phase10 e2e opens every page as each role with no crash, console error or failed request, and every visible button and link has a readable name |
| Every calculation | **Pass** | Integration tests check each figure on known data (status and delay, quantities, balances, reliability factors, quotation statistics, dashboard KPIs, weekly report sections A–F) |
| Concurrent users, role permissions | **Pass** | See tests 1, 2 and 11 above |
| Reassignment, commitment history, partial returns, inspection, multiple payments | **Pass** | Examples 2–5 and 8 |
| Reminders | **Pass** | phase7 (schedule, no duplicates, recipients, recalculation, database scheduler); e2e phase7 |
| Weekly reports | **Pass** | phase8 (sections A–F on known data, automatic schedule once a week, permissions, permanent history); e2e phase8 (PDF and Excel) |
| Backup and restore | **Pass** | Test 10 |
| Excel import and export | **Pass** | jobs (preview, import of chains, missing data kept empty, duplicates skipped); e2e jobs (import of the original layout); the real workbook is recognised (`excelImport.test.ts`) and was not modified (SHA-256 identical to the Phase 1 backup copy) |
| Server restart and data persistence | **Pass** | The whole local Supabase stack was stopped and started (30 s): job, assignment, vendor, user, file and history counts and a fingerprint of every job record were identical, both scheduled jobs active, sign-in worked. On the live project Supabase runs the database; this is re-checked after deployment |
| Remote access from multiple devices | **Live** | Phone layouts tested in the browser (e2e, every phase); real devices after deployment |
| Critical bugs fixed | **Done** | See `docs/PHASE10_REPORT.md` |

## Dependency vulnerabilities

0 critical, 0 high, 9 moderate (all inside `exceljs`, not reachable): `docs/DEPENDENCY_VULNERABILITIES.md`. CI fails on any new high
or critical finding.
