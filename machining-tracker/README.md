# CESS Machining Job Tracker

Online, multi-user application for outsourced machining jobs and vendor management.
Free-first stack: **React + TypeScript + Vite + Tailwind** (static site on Cloudflare) and **Supabase Free**
(PostgreSQL, Auth with MFA, Storage, Realtime, Edge Functions). Mandatory running cost: **₹0**.

> Status: **Phases 3 to 8 complete and tested locally. Not deployed yet.** See `docs/PHASE3_REPORT.md` to `docs/PHASE8_REPORT.md`.

## What works today
- Invitation-only accounts, sign-in, sign-out, sign out on all devices
- Authenticator-app MFA (mandatory for Admin and Manager, optional for Staff)
- Password reset by one-time link (works without an email service) or email (when SMTP is configured)
- Server-enforced roles and permissions (Admin / Manager / Staff), per-user exceptions, MFA policy per role
- Server-side session revocation, idle timeout and maximum session length
- Settings: company, date format, work categories and Given By names (from the Excel workbook), cancellation reasons
  (vendor-caused vs not), reliability weights (approved Option 1: 30/25/15/10/10/10), job thresholds, session security
- Append-only Activity History with before/after values and reasons; Supabase sign-in events
- System Health: database and storage usage against free-plan limits, backup status, row counts
- Responsive layout (desktop, tablet, phone); live refresh of shared settings (Realtime)
- **Encrypted, verified backups** on your Windows PC (daily via Task Scheduler), with tested restore and disaster recovery
  (`docs/BACKUP_AND_RECOVERY.md`, double-click scripts in `scripts/windows/`)

- **Jobs**: New Job, Jobs Register (tabs, search, filters, Excel export), job page with vendor journey, cancel & forward
  with mandatory reason, attachments, Missing Data Review (`docs/PHASE4_REPORT.md`, `docs/STATUS_RULES.md`)
- **Vendors**: vendor master with categories and contacts, vendor page with counts, Excel export
- **Excel import** of the original tracker (or templates) with a server-checked preview

- **Commitment history**: revise committed dates (original kept, every revision numbered with reason and who asked), timeline per job,
  frequently revised jobs and vendors highlighted
- **Vendor reliability**: six-factor score (30/25/15/10/10/10) per vendor and per category, by financial year, with sample sizes,
  "insufficient data" instead of misleading scores, and a "how this score was calculated" panel listing every job counted
- **Cost comparison**: quotations per requirement, lowest/highest/average and % differences, charts, a recommendation that is not
  price-only, manual choice and confirmed job creation, price history per vendor (`docs/RELIABILITY_RULES.md`)

- **Material returns and quality inspection**: partial returns, accepted / rejected / rework quantities, pieces still with the vendor,
  automatic completion only when every piece is back and inspected, close or reopen with a reason, voids instead of edits
- **Vendor payments**: invoice, advances, payments, additional charges and discounts per vendor; total payable, balance and status;
  reversals instead of edits; pending payments, vendor-wise totals, payment statements, monthly and FY payments
  (`docs/RETURNS_AND_PAYMENTS.md`). Admin records payments; Managers view

- **WhatsApp click-to-chat**: ten editable templates filled from the job, edit before sending, WhatsApp opens and you press Send;
  communication history (recorded as opened, never claimed as sent), duplicate warning
- **Reminder engine** on the server (pg_cron, Indian time): 3 and 1 day before, on the day, overdue daily; no duplicates; follows the
  latest committed date; stops when completed or cancelled. **Notification center** with live unread count
  (`docs/WHATSAPP_AND_REMINDERS.md`)

- **Dashboard**: 10 KPIs, 8 charts and 7 tables from live data, each opening the matching records; Staff see their own jobs
- **Weekly management report**: automatic every Monday (configurable) and on request, sections A-F with previous-week comparison,
  PDF and Excel downloads, permanent history; **Quality** records page with export (`docs/DASHBOARD_AND_REPORTS.md`)

Deployment (Phase 9) and final acceptance testing (Phase 10) follow.

## Folder structure
```
machining-tracker/
├─ apps/web/                 React app (Vite). src/pages, src/components, src/auth, src/lib
├─ packages/shared/          Zod settings schemas, permission keys, India-time date helpers (+ unit tests)
├─ supabase/
│  ├─ migrations/            Version-controlled SQL: tables, RLS, functions, triggers, seed data
│  ├─ functions/admin-users/ Edge Function for invitations and reset links (no third-party imports)
│  ├─ templates/             Email templates (token_hash links)
│  └─ config.toml            LOCAL development stack settings
├─ tools/backup/             Backup / verify / restore tool (Node 22, runs the TypeScript directly)
├─ scripts/windows/          Double-click .cmd files: backup setup, backup now, schedule, list, verify, restore
├─ tests/
│  ├─ integration/           Security tests against a real local Supabase stack
│  ├─ e2e/                   Playwright browser tests (desktop + phone)
│  └─ helpers/
└─ docs/                     Setup, security, free-tier verification, phase reports, screenshots
```

## Local development (for building and testing; not needed to *use* the app)
Requirements: Node.js 22, Docker (Docker Desktop on Windows: free for personal use and small businesses under its licence terms).

```bash
npm ci
```
```bash
npm run db:start
```
`db:start` starts a private Supabase stack on this computer (database, Auth, API, local mail catcher at http://127.0.0.1:54324).

Create `apps/web/.env.local` with the local URL and publishable key printed by `npx supabase status`:
```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```
```bash
npm run dev
```
Then open http://127.0.0.1:5173. To create a local Admin, add a user in the local stack and run the bootstrap SQL (`docs/SETUP_ACCOUNTS.md`, step 5).

## Tests
```bash
npm run test:unit
```
```bash
npm run test:integration
```
```bash
npm run test:e2e
```
```bash
npm run typecheck
```
The integration and e2e commands **reset the local database** first; they refuse to run against anything other than `127.0.0.1`.

## Deployment
Not done yet. Accounts, credentials and exact steps: `docs/SETUP_ACCOUNTS.md`. Nothing is created or paid for without your approval.

## Backups
Supabase Free has no backups, so `tools/backup` makes them on your PC: encrypted, test-restored before being marked verified, kept by
safe retention rules, optionally copied to a USB drive. Setup and restore steps: `docs/BACKUP_AND_RECOVERY.md`.

## Security
See `docs/SECURITY.md`. Never put the secret/service key or database password in the website, Cloudflare or Git.
