# Phase 10 report: final testing and handover

Status: **all local acceptance testing is complete; the live checks are waiting for deployment** (Phase 9 needs your Supabase and
Cloudflare accounts). The application is not described as production-ready until the live checks in `docs/SECURITY_TEST_REPORT.md`
(items marked "Live") have passed against the public HTTPS address.

## What was tested

Every item of the Phase 10 list, the 11 business-rule examples and the 15 final security acceptance tests are mapped to the tests
that prove them in **`docs/SECURITY_TEST_REPORT.md`**. New in this phase:

| Test | What it proves |
|---|---|
| Example 11 with real business records (`phase10-restore.test.ts`) | Two vendors' jobs with a reassignment, a revised date, a partial return and inspection, invoice, payments with a reversal, an adjustment, three quotations, WhatsApp log, reminders, weekly report and a drawing are backed up and verified; the **whole database is lost**; after the restore **every screen's data is identical**, payments and history still cannot be altered, and job and payment numbers continue without duplicates |
| Security tests 5, 6, 7, 11 (`phase10-security.test.ts`) | Passwords only as salted bcrypt hashes; files have no public URL; expired download links stop working; simultaneous saves by two people: different jobs both kept, the same job cannot be silently overwritten |
| Every page as every role (`tests/e2e/phase10.spec.ts`) | All 23 pages opened as Admin, Manager and Staff: allowed pages open with no crash, console error or failed request, every button and link has a readable name; the rest show "No access" |
| Two tabs editing one job (browser) | The other tab is warned at once ("Changed by someone else"), keeps its typing, and its save is refused; the first change stays |
| Error messages (`errors.test.ts`) | Internal database details never reach the screen |
| Server restart | Whole local stack stopped and started: all records identical (fingerprint of every job), scheduled jobs active, sign-in works |
| Git history | All 20 commits scanned: no key, token or password |
| Dependencies | 0 critical, 0 high, 9 moderate (inside `exceljs`, not reachable): `docs/DEPENDENCY_VULNERABILITIES.md` |

## Results (2026-11-03)

| Suite | Result |
|---|---|
| Unit | 76 / 76 |
| Integration (real local Supabase, all phases) | 116 / 116 |
| Browser (Playwright, all phases) | 28 / 28 |
| Production build served like Cloudflare | 3 / 3 |
| Type check | clean |
| GitHub Actions CI on the pull request | green (both jobs) |

## Bugs found and fixed in Phases 9 and 10

| Problem | Effect before | Fix |
|---|---|---|
| Backup verification compared only the Phase 3 figures | A backup missing business records would still have matched the checks (the restore itself was correct) | Business checks for jobs, assignments, money, returns, inspections, quotations, history and files |
| Raw database errors were shown as they came | Messages such as "permission denied for table …" or constraint names could appear on screen | Only the app's own rule messages and sign-in messages are shown; anything else becomes a plain message with an error code |
| A page crash left a blank white page | Users saw nothing and could not recover | Recovery screen with "Reload page" and "Home page", no technical details |
| Edge Function read only the old Supabase key names | Inviting users would fail on new projects without legacy keys | Reads the current keys first |
| Edge Function relied on the platform JWT check | Supabase warns it breaks with the new signing keys | The function checks every caller itself; forged tokens tested |
| Edit windows reloaded when someone else saved the same record | Unsaved typing was silently replaced (no data was overwritten, but work was lost without notice; found by the two-tab test) | The job, vendor assignment, vendor, requirement and quotation edit windows keep the typing, show "Changed by someone else", and send the version the user started from so the server refuses the save |
| WhatsApp template "Saved." vanished at once | The Admin could not tell the save worked | The editor keeps its message |
| Catch-all `_redirects` rule | On Cloudflare it would also apply to real files | Removed; Pages serves the app for unknown paths itself |
| Three browser tests depended on timing | Random failures | Exact link names |

## New documents (security delivery)

| Document | Content |
|---|---|
| `SECURITY.md` | Security architecture, authentication and authorization (links to all below) |
| `PERMISSION_MATRIX.md` | Every permission for Admin, Manager and Staff, generated from the database |
| `DATABASE_SECURITY.md` | Row security, grants, functions, protected and audited tables, generated from the database |
| `CLOUD_SECURITY.md` | Supabase, Cloudflare and GitHub settings; where each secret lives |
| `BACKUP_AND_RECOVERY.md` | Backup and restore guide (updated) |
| `DISASTER_RECOVERY.md` | Ten scenarios with steps and recovery targets |
| `DEPLOYMENT.md` | Deployment steps and the production checklist |
| `SECURITY_TEST_REPORT.md` | The 15 security tests, the 11 examples and the Phase 10 list with evidence |
| `DEPENDENCY_VULNERABILITIES.md` | `npm audit` results and analysis |
| `ADMIN_SECURITY_GUIDE.md` | Managing people, lost authenticators, regular checks, incidents |

## Still open (needs the live deployment)

1. `verify.mjs` against the public HTTPS address: HTTPS, headers, no secrets, nothing readable without signing in, Edge Function rules.
2. Test 4 (failed sign-ins blocked): `verify.mjs --check-login-limit`, run from this container, not from your office.
3. Sign-in and main journeys through the public address, on a phone and a PC.
4. Backup tool against the hosted database on your PC (`backup-now.cmd` → VERIFIED).

## Decisions for you

1. **Make the GitHub repository private** (recommended; it is public today).
2. **Lost authenticator:** today an Admin resets it with one SQL command in the Supabase dashboard (`ADMIN_SECURITY_GUIDE.md`). I can
   add a "Reset authenticator" button for Admins (Edge Function, MFA-protected, recorded in the history) if you want it in the app.
