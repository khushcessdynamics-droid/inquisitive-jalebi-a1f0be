> **SUPERSEDED (2026-11-02):** replaced by the approved free-first online architecture (Supabase + Cloudflare). See `machining-tracker/README.md` and `machining-tracker/docs/`. Kept for history.

# CESS Machining Job Tracker — Revised Local Architecture (personal use, ₹0 running cost)

Status: **AWAITING YOUR APPROVAL. No application code written. No service purchased or activated.**
This document replaces the cloud plan in `PHASE2_ARCHITECTURE_PROPOSAL.md` and `PHASE3_FINAL_APPROVAL_PACKAGE.md`.
Business rules, formulas, statuses, validation rules and the permission model from those documents remain in force
unless this document says otherwise.

---
## 1. Summary
- Runs on your Windows PC, in your browser, at `http://localhost:4100`. Works offline after the first install.
- One process (Node.js) serves the app and the API, runs the scheduler and makes backups. One SQLite database file. Attachments in a local folder.
- One Admin user (you). Database tables, permission checks and audit logging stay user-aware, so more users can be added later without redesign.
- Every core feature is kept. No feature is dropped to make the app free; each cloud service is replaced by a free local equivalent (§4).
- **Mandatory monthly cost: ₹0.** Every component is free, open-source software (§9).

## 2. Architecture
```
Your browser (Edge/Chrome) ── http://localhost:4100 ──┐
                                                       ▼
            Node.js process (Express + TypeScript), bound to 127.0.0.1 only
            ├─ REST API + serves the built React app (same origin)
            ├─ Domain layer: pure, unit-tested calculations (status, dates in Asia/Kolkata,
            │   money, quantities, quality, payments, quotations, reliability score)
            ├─ Scheduler: persistent task table, catch-up after the PC was off, retries
            ├─ Storage provider: LocalStorage (S3/R2 adapter can be added later)
            ├─ Backup service: SQLite snapshot + attachments → verified .zip
            └─ Optional Windows desktop notifications (local, no internet)
                     │
         Data folder (outside the code folder)
         ├─ db/tracker.db            SQLite (WAL mode, foreign keys ON)
         ├─ attachments/             files named by UUID, never served directly
         ├─ backups/                 verified backup archives (+ optional second location)
         ├─ reports/                 generated weekly PDFs/Excel
         ├─ logs/                    structured logs with secrets redacted
         └─ config/.env              generated secrets (never in Git)
```
Bound to `127.0.0.1`, so no other computer on the network can reach the app. LAN or phone access is an optional later upgrade (§10).

Tech stack (as you specified): React + TypeScript + Vite + Tailwind CSS + Recharts; Node.js + Express + TypeScript;
SQLite + Prisma; Zod (shared by frontend and backend); ExcelJS; pdfmake for PDFs; TanStack Query; Vitest + Supertest + Playwright for tests.
Library versions are pinned in `package-lock.json`.

## 3. Folder structure
```
machining-tracker/                     (new folder in this repo; existing index.html, legacy/ and docs/ untouched)
├─ START-TRACKER.bat                   one-click start: first-run setup, migrate, start, open browser
├─ STOP-TRACKER.bat
├─ scripts/windows/                    create desktop shortcut, optional "start with Windows", backup-now
├─ package.json                        npm workspaces
├─ .env.example                        documents every setting; real .env lives in the data folder
├─ README.md                           install, start, update, backup/restore, troubleshooting
├─ docs/                               formulas, permission matrix, backup & recovery guide, user guide
├─ packages/shared/                    Zod schemas, types, status & permission keys, constants
├─ apps/api/
│  ├─ prisma/  schema.prisma, migrations/, seed.ts (categories + Given By names only, no fake data)
│  └─ src/
│     ├─ app.ts, server.ts, config/
│     ├─ middleware/   auth, permissions, csrf, rate-limit, validate, errors
│     ├─ domain/       status.ts, dates.ts, money.ts, quantities.ts, quality.ts, payments.ts,
│     │                quotations.ts, reliability.ts   (pure functions + tests)
│     ├─ modules/      auth, users, settings, vendors, jobs, assignments, commitments, returns,
│     │                quality, payments, quotations, reliability, attachments, whatsapp,
│     │                reminders, notifications, activity, dashboard, reports, import-export,
│     │                backup, system-health   (each: routes, service, schemas, tests)
│     ├─ scheduler/    task runner, catch-up, retry, run history
│     ├─ storage/      StorageProvider interface + LocalStorage
│     └─ cli/          reset-password, verify-backup, restore-backup
└─ apps/web/
   └─ src/  app shell + sidebar, pages per module, shared table/form/filter components, API client
```

## 4. Cloud plan → local replacement (no features removed)
| Previously planned | Local, free replacement |
|---|---|
| Render hosting | Node.js on your PC, started by `START-TRACKER.bat` |
| PostgreSQL | SQLite file. Prisma schema kept portable, so switching to PostgreSQL later is a planned migration |
| pg-boss queue | Scheduler with persistent task and run tables in SQLite: retries, duplicate keys, catch-up on start |
| Cloudflare R2 | Local `attachments/` folder behind authenticated download endpoints |
| Backblaze B2 / PITR | Local verified backups + optional copy to a USB/external drive or a free cloud-synced folder |
| Email provider | Not needed. Password recovery uses recovery codes and a local command. Email adapter stays an optional upgrade |
| WhatsApp Cloud API | Click-to-chat (`wa.me`) links with prefilled, editable messages. You press Send. Logged as "initiated", never as "sent" |
| Multi-user + invitations | One Admin. Roles/permission checks kept in code; a users screen can be enabled later |
| MFA for Admin/Manager | TOTP authenticator support kept (free, offline). See Q2 for when it is required |
| Cloud monitoring | Local System Health page: database status, last backup, scheduler status, failed tasks, recent errors, disk usage |

## 5. Data and database design changes for SQLite
The entities from the approved design are unchanged: jobs (one combined Part No / Part Name field), job assignments
(parent job + linked vendor attempts), commitment history, returns, inspections, payments, quotations, attachments,
WhatsApp log, reminders, notifications, activity log, weekly reports, settings, users, backups and imports.
SQLite-specific choices:
- Money is stored as **integer paise** (exact, no rounding errors). Quantities are integers. Quantity and commitment date are NULL when unknown.
- Business dates are stored as `YYYY-MM-DD` text, so a date never shifts with timezone. Event timestamps are stored in UTC and shown in IST. All "today" logic uses one Asia/Kolkata clock module that tests can control.
- Enum-like values (statuses, reasons, payment modes) are stored as text and checked by Zod and the domain layer.
- **Append-only protection via SQLite triggers** that block UPDATE/DELETE on the activity log, commitment history, payments, quality inspections and material returns. Corrections are new rows (reversal entries, superseding inspections). The original commitment date is protected by a trigger.
- Optimistic locking (`version` column) still applies: two browser tabs editing the same job get "changed elsewhere, reload".
- WAL mode, `foreign_keys=ON`, `busy_timeout`, and `PRAGMA integrity_check` on startup.
- Users table, role field and the permission middleware are kept. You are Admin with all permissions; the approved Admin/Manager/Staff matrix is stored as data for future use.

## 6. Login and security (local)
- **First run:** no user exists, so the console window prints a one-time setup code. The browser opens a "Create Admin" page that needs that code. You choose your username and password. Nothing is hardcoded or stored in source.
- Passwords are hashed with **Argon2id** (`@node-rs/argon2`, prebuilt for Windows, no compiler needed). Minimum 12 characters.
- Session cookie is HttpOnly and SameSite=Strict, with the session stored in the database. Idle timeout (default 30 min, configurable), logout, and logout of all sessions. Changing the password revokes all other sessions.
- Login rate limiting, plus a temporary lockout after 5 failed attempts. Failed logins are recorded in the audit log.
- CSRF protection (same-origin check + token), strict security headers and Content-Security-Policy (`helmet`). No external CDNs; fonts are bundled, so the app works offline.
- Zod validation on every API input. Prisma parameterised queries. React output encoding.
- **Password recovery without email:** 10 one-time recovery codes are shown once at setup, and there is a `RESET-PASSWORD.bat` command that only works on this PC.
- Secrets (session key, TOTP encryption key) are generated on first run into `config/.env` in the data folder, which is git-ignored.
- Attachments: type and size checks (default 50 MB), magic-byte checks where the format has them, UUID filenames, SHA-256 stored, served only to a logged-in session, archived rather than deleted. Windows Defender scans new files in real time; I won't claim any other scanning.
- **At-rest protection (honest note):** SQLite and the attachment folder are not encrypted by the app. Protection at rest comes from your Windows login plus BitLocker/Device Encryption (free with Windows; full BitLocker needs Windows Pro). I'll document how to check it.

## 7. Backup and restore (local)
- **What is backed up:** a consistent database snapshot (`VACUUM INTO`, safe while the app runs) + all attachments + a manifest with SHA-256 checksums and row counts, packed into one `.zip`.
- **When:** daily at a configurable time; manual "Backup now"; automatically before every restore and before every database migration. If the PC was off at the scheduled time, the backup runs on next start.
- **Verification (each backup):** extract to a temp folder, open the database copy, run `integrity_check` + `foreign_key_check`, compare row counts and payment totals with the manifest, check every attachment checksum. Only then is the backup marked **Verified**. A failed backup or verification shows an alert on the dashboard.
- **Retention:** default 14 daily + 8 weekly + 12 monthly, configurable. **The newest verified backup is never deleted, and no backup is deleted unless a newer verified one exists.** Backups are never overwritten (unique timestamped names).
- **Second copy:** you can set a second backup folder (USB/external drive, or a free OneDrive/Google Drive folder). The live database is never placed in a synced folder, because syncing a live SQLite file can corrupt it.
- **Restore:** pick a backup → the app verifies it → shows date, contents and counts → you confirm by typing `RESTORE` → a safety backup of the current data is taken → scheduler paused → database and attachments replaced → app restarts. Also available from the console if the app won't start.
- **Honest limits:** backups kept only on the same disk do not protect against disk failure or theft. The second copy covers that. Recovery point = time since last backup (default ≤ 24 h, shorter if you schedule more often). Recovery time ≈ minutes.

## 8. Reminders, notifications, reports and WhatsApp
- Reminder engine as approved: 3 days before, 1 day before, on the date, 1 day overdue, then daily. Configurable, Asia/Kolkata, duplicate-proof (unique key per assignment/rule/date), recalculated when the commitment date changes, stopped on completion or cancellation, none for jobs with no commitment date.
- **Honest limit:** reminders and scheduled tasks run only while the PC is on and the app is running. On start, the scheduler catches up missed reminders, backups and weekly reports. An optional "Start with Windows" shortcut keeps it running whenever you are logged in.
- In-app Notification Center, plus optional Windows desktop pop-ups (local, free).
- Weekly report every Monday for the previous Monday–Sunday (configurable). PDF + Excel saved to `reports/` with history and week-on-week comparison. Built only from real records.
- WhatsApp: the 10 editable templates, with placeholders filled from the job. "Open WhatsApp" opens WhatsApp Desktop or Web with the message prefilled. You send it yourself. Recorded as "initiated" with a duplicate warning if the same message was opened recently.

## 9. Confirmation: the core app runs with ₹0 subscriptions
| Component | Licence | Cost |
|---|---|---|
| Node.js LTS | MIT | ₹0 |
| React, Vite, Tailwind CSS, Recharts, TanStack Query | MIT | ₹0 |
| Express, helmet, express-rate-limit, Zod | MIT | ₹0 |
| Prisma ORM | Apache-2.0 | ₹0 |
| SQLite | Public domain | ₹0 |
| ExcelJS, pdfmake, archiver | MIT | ₹0 |
| @node-rs/argon2, otplib (TOTP) | MIT | ₹0 |
| Vitest, Supertest, Playwright (testing) | MIT / Apache-2.0 | ₹0 |
| Authenticator app (Google/Microsoft Authenticator), WhatsApp Desktop/Web | free apps | ₹0 |
No account, API key or subscription is needed to install or run the app.

**Optional things that could cost money (none required):**
- External USB drive for the second backup copy: one-time hardware purchase, only if you don't already have one. A free OneDrive (5 GB) or Google Drive (15 GB) folder also works.
- Future upgrades only if you ask for them later: cloud hosting/PostgreSQL, a domain, email provider, WhatsApp Business API (Meta charges per conversation).
- GitHub Actions on a `windows-latest` runner to test the Windows start scripts: free for public repos and within the free monthly minutes for private repos. Optional; I'll ask before enabling it.

## 10. Optional future upgrades (not built now, kept possible)
- **PostgreSQL:** switch the Prisma provider, re-create the SQLite triggers as Postgres triggers, and run the data copy script I'll document.
- **Phone/LAN access:** bind to the LAN IP, require TOTP, and use HTTPS with a local certificate. Free.
- **Anywhere access:** a free tunnel (Cloudflare Tunnel or Tailscale personal plan) with MFA, without moving the data off your PC.
- **Cloud backups, email, WhatsApp API, more users:** adapters and tables already exist; each is enabled only if you decide.

## 11. Setup requirements (Windows)
- Windows 10 or 11, 64-bit. About 1 GB free disk for the app, plus space for your data and backups.
- **Node.js 22 LTS** (free installer from nodejs.org, one-time; needs permission to install software on the PC).
- Internet only for the first install (downloads libraries). After that it runs offline.
- Microsoft Edge or Google Chrome.
- Getting the code: download the ZIP from GitHub, or use Git for Windows (free).
- **Start:** double-click `START-TRACKER.bat`. The first run installs libraries, creates the data folder and database, prints the setup code and opens the browser. Later runs start in seconds. A desktop shortcut script is included.
- **Update:** replace the code folder (data folder is separate), run `START-TRACKER.bat`; it takes a backup and then applies migrations.

**Testing note:** I build and test in a Linux container. The pure logic, API and browser tests run here; the `.bat` scripts and Windows-specific behaviour (paths, desktop notifications, auto-start) can only be fully confirmed on your PC or on a Windows CI runner. I'll list exactly what you need to check.

## 12. Revised phases
3. **Foundation:** project setup, Windows start scripts, full Prisma schema + migrations, triggers, seed (categories, Given By), first-Admin setup, login/logout/sessions/rate limit/lockout/password change/recovery codes/optional TOTP, permission middleware, audit log infrastructure, settings (categories, Given By, company info, FY, date format), app shell, local backup + verify + restore, System Health page.
4. **Core jobs & vendors:** job entry, Jobs Register with search/filters/export, pending/completed/cancelled views, vendor master, cancel & reassign with vendor journey, attachments, Excel import (workbook mapping, preview, duplicate detection, Missing Data Review) and exports/templates.
5. **Vendor intelligence:** commitment history and timeline, six-factor reliability score, cost comparison with recommendation (never auto-assigns).
6. **Material & finance:** returns, quality inspections, payments ledger, vendor statements.
7. **Communication & automation:** WhatsApp click-to-chat templates, reminder engine, Notification Center, desktop notifications.
8. **Reports & audit:** activity history UI, dashboard with drill-down, weekly reports (PDF/Excel), report history.
9. **Windows hardening:** auto-start option, update procedure, backup second location, restore drill, user and recovery guides.
10. **Final testing and handover:** every form, calculation and scenario from your test list (personal-use versions of the multi-user tests: two-tab concurrent edit, direct API calls without login rejected).

## 13. Questions
- **Q1 Reliability weights (needed by Phase 5):** you referred to the "approved" six-factor weights, but a weight option was never chosen. Option 1: On-time 30 / Quality 25 / Delay 15 / Stability 10 / Completion time 10 / Vendor-caused cancellation 10. Option 2: 32 / 23 / 18 / 9 / 8 / 10. Or your own numbers.
- **Q2 MFA:** the earlier approval made MFA mandatory for Admin. For a localhost-only personal app I propose: TOTP available and recommended but **off by default**, and **automatically required** if LAN/remote access is ever enabled. Or keep it mandatory from day one?
- **Q3 Data folder:** default `C:\Users\<you>\CESS-Machining-Data` (separate from the code, not inside OneDrive). OK, or another drive?
- **Q4 Access:** this PC only for now (recommended). Confirm you don't need phone access over office Wi-Fi from day one.
