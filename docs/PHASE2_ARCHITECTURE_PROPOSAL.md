# CESS Machining Job Tracker — Architecture Proposal (for approval)

Status: **PROPOSAL. No application code written. No paid service activated.**
All prices below are my estimates from general knowledge, NOT live quotes. They must be re-checked
on each provider's pricing page before you approve anything.

## 1. Repository analysis
- Repo contains only `index.html` (a Netlify-hosted "CESS Stock · Inventory Control" single-file app using Supabase).
  It is unrelated to the machining tracker. It is not modified.
- Added in PR #1: `legacy/` (original workbook + identical backup) and `docs/PHASE1_WORKBOOK_ANALYSIS.md`.
- Proposal: build the tracker in `/machining-tracker` (npm workspaces: `apps/web`, `apps/api`, `packages/shared`)
  so the inventory app keeps deploying untouched. A separate repo is cleaner if you prefer (Q1).

## 2. Workbook analysis (summary; detail in PHASE1 doc)
Empty template: no job/vendor rows. Only data to migrate: 11 work categories, 3 Given By names.
Existing rules to preserve: status logic, days-taken, late flag (>10 days, configurable), cancel-and-forward
as a new linked row, per-category vendor ranking, April–March FY.
Importer must still accept the ENTRY/VENDORS column layout for future data. Migration rules (from your spec):
missing quantity → NULL ("Not Specified", shown in Missing Data Review); missing commitment date → NULL,
status "Commitment Date Missing", no reminders, excluded from on-time metrics; combined "Part No / Part Name"
kept as one text field; legacy "Phone No" → Mobile, WhatsApp left blank.

## 3. Recommended architecture
```
Browser (React+TS+Vite+Tailwind+Recharts)
   │ HTTPS (TLS 1.2+, HSTS)
Node 20 + Express + TypeScript (REST, Zod validation)   ← single container, serves API + built frontend
   ├─ PostgreSQL (Prisma) — jobs, audit, sessions, job queue
   ├─ pg-boss worker (same codebase, own process) — reminders, weekly reports, backups, retries
   ├─ S3-compatible PRIVATE bucket — attachments (short-lived signed URLs)
   └─ Email (SMTP/API) · WhatsApp Cloud API (optional, off by default)
```
Decisions and why:
- **Same-origin deploy (API serves the SPA)**: no CORS surface, simpler cookies/CSRF, one thing to deploy.
- **pg-boss queue on Postgres** instead of Redis: persistent, retries, dedupe keys (`singletonKey`), survives restarts,
  one fewer paid component. Cron is evaluated in Asia/Kolkata.
- **Server-side sessions in Postgres** (opaque ID in HttpOnly, Secure, SameSite=Lax cookie) rather than JWTs:
  immediate revocation on deactivation/password change/"log out everywhere". CSRF protection via double-submit token.
- **Argon2id** hashing; **TOTP MFA** (otplib) with recovery codes; MFA mandatory for Admin, optional-by-policy for others (Q5).
- **Real-time sync**: all users read the same DB; UI refreshes via TanStack Query polling/invalidation plus
  Server-Sent Events for "record changed" hints. Writes use **optimistic locking** (`version` column; 409 → "changed by another user").
- Money stored as integer paise (BigInt) / `NUMERIC(14,2)`, never floats. Dates: `DATE` for business dates, `TIMESTAMPTZ` for events;
  all "today" logic evaluated in Asia/Kolkata.

## 4. Hosting comparison and recommendation
| | A. Render + R2 (simplest) | B. AWS Mumbai (ap-south-1) | C. Railway / Fly |
|---|---|---|---|
| Region | Singapore (no India region) | **India** | Singapore |
| App | Web service + worker | App Runner/ECS Fargate | containers |
| Postgres | Managed, paid tier has daily backups + PITR | RDS (PITR, encrypted, private VPC) | managed/self |
| Files | Cloudflare R2 (private, no egress fees) | S3 (private, SSE) | R2/S3 |
| Ops effort | Low | Medium–High | Low–Medium |
| Est. monthly (small team) | ~US$25–45 (≈₹2,100–3,800) | ~US$45–80 (≈₹3,800–6,700) | ~US$20–40 |

**Recommendation: Option A to start** (fast to deploy/rollback, managed Postgres with PITR, ~60–80 ms from India),
with the code kept portable (Docker, standard Postgres, S3 API) so moving to AWS Mumbai later is a config change.
Choose B instead if data must stay in India. Backups always go to a **different provider** (see §8).

Indicative cost lines (Option A, ≤10 users, <20 GB files) — **verify before approval**:
| Item | Est. /month |
|---|---|
| Frontend hosting | $0 (served by backend) |
| Backend web + worker | $14–25 |
| PostgreSQL (paid, PITR) | $7–20 |
| File storage (R2) | $0–1 |
| Backup storage (separate provider, e.g. Backblaze B2) | $0–1 |
| Domain | ~$1 (≈₹1,000/yr) |
| Email (transactional) | $0 (free tier) |
| Monitoring/logging (Sentry free + provider logs) | $0 |
| WhatsApp Cloud API | per-conversation Meta charges; $0 until enabled |
| **Total** | **≈ $25–45** |
Free tiers are NOT suitable for production: free Postgres tiers expire/lack PITR and free web services sleep,
which would break the reminder scheduler. Growth: cost mainly rises with DB size/CPU; 50 users or 100 GB files
would be roughly $60–120/month.

## 5. Environments
Development (local Docker Postgres, synthetic data only) · Staging (separate DB/bucket/secrets, restore-test target) ·
Production. Separate credentials per environment, no real payment data outside production, migrations rehearsed on staging,
verified backup taken before each production migration, rollback = redeploy previous image + (if needed) PITR/restore.
CI: lint, typecheck, tests, `npm audit`, secret scan, Prisma migrate on throw-away DB.

## 6. Roles and permission matrix (Admin-configurable; enforced in backend middleware on every route)
Permissions are rows in `permissions`, mapped to roles in `role_permissions`; defaults:

| Permission | Admin | Manager | Staff |
|---|---|---|---|
| jobs.view | ✔ | ✔ | ✔ (assigned/own, configurable) |
| jobs.create | ✔ | ✔ | ✔ |
| jobs.edit | ✔ | ✔ | ✔ (limited fields) |
| jobs.archive | ✔ | ✘ | ✘ |
| vendors.manage | ✔ | ✔ | ✘ (view only) |
| assignments.change | ✔ | ✔ | ✘ |
| commitments.change | ✔ | ✔ | ✘ |
| jobs.cancel | ✔ | ✔ | ✘ |
| reliability.view | ✔ | ✔ | ✘ |
| costcompare.view | ✔ | ✔ | ✘ |
| quality.manage | ✔ | ✔ | ✘ |
| returns.record | ✔ | ✔ | ✔ (if granted) |
| payments.view | ✔ | ✔ | ✘ |
| payments.edit | ✔ | ✘ (grantable) | ✘ |
| reports.export | ✔ | ✔ | ✘ |
| users.manage | ✔ | ✘ | ✘ |
| settings.change | ✔ | ✘ | ✘ |
| activity.view | ✔ | ✘ (grantable) | ✘ |
Adjust any cell you disagree with (Q6).

## 7. Database design (PostgreSQL, Prisma)
Conventions: `id` UUID PK, `created_at/updated_at`, `version` int (optimistic lock), `deleted_at` (soft delete) on business tables.

- **users**(email uniq, name, password_hash, role_id, is_active, mfa_secret_enc, failed_logins, locked_until, last_login)
- **roles**, **permissions**, **role_permissions**; **sessions**(user_id, expires_at, last_seen, ip, ua, revoked_at); **password_resets**; **mfa_recovery_codes**
- **vendors**(code uniq, company_name, contact_person, mobile, wa_country_code, wa_number, wa_opt_in_at, email, address, gst_no, payment_terms, remarks, is_active) · **vendor_categories**(vendor_id, work_category_id)
- **work_categories**, **given_by_names** (seeded from workbook; editable)
- **jobs** — the parent (one per part/requirement): job_no uniq (e.g. `JOB-2526-0001`), part_label (combined "Part No / Part Name", indexed with pg_trgm), description, qty_sent NULLABLE, category_id, given_by_id, date_given, estimated_amount, remarks, status_override_reason/closed_by
- **job_assignments** — one per vendor attempt: job_id, vendor_id, sequence_no, parent_assignment_id, dispatched_on, qty_sent, original_commitment_date NULLABLE (immutable), current_commitment_date NULLABLE, state (active/completed/cancelled), cancelled_on, cancel_reason_code, cancel_reason_text (mandatory), cancel_vendor_related bool, forwarded_to_assignment_id, amount. Unique (job_id, sequence_no); partial unique index = one *active* assignment per job.
- **commitment_history** — append-only: assignment_id, revision_no, original_date, previous_date, new_date, changed_at, changed_by, reason
- **material_dispatches**, **material_returns**(assignment_id, qty_received, returned_on, received_by), **quality_inspections**(return_id, inspected_on, inspected_by, accepted_qty, rejected_qty, rework_qty, status, remarks; corrections create new rows, old ones superseded not edited). CHECK: accepted+rejected+rework ≤ qty_received.
- **payments**(assignment_id, kind advance/payment/reversal, amount, paid_on, mode, txn_ref, remarks, created_by; **no UPDATE/DELETE** — corrections are reversal + new entry), **payment_adjustments**(additional_charges, discount per assignment). Duplicate guard: unique (assignment_id, mode, txn_ref) where txn_ref not null, plus idempotency key on create.
- **vendor_quotations**(requirement_label, qty, category_id, vendor_id, quoted_amount, per_part_rate, delivery_days, quoted_on, remarks, selected bool)
- **whatsapp_templates**, **whatsapp_messages**(mode manual/api, status queued→accepted→sent→delivered→read/failed, provider_msg_id, dedupe_key uniq, initiated_by)
- **reminder_rules** (settings), **reminders**(assignment_id, rule_key, due_on, unique(assignment_id, rule_key, due_on)), **notifications**(user_id, type, ref, read_at)
- **activity_logs** — append-only (DB trigger blocks UPDATE/DELETE; app DB role has INSERT/SELECT only): actor id+name, action, module, job_id, vendor_id, previous/new JSONB, reason, ip, session_id, at
- **weekly_reports**(period_start, period_end, payload JSONB, pdf_key, xlsx_key, generated_at, delivery_status)
- **attachments**(job_id, assignment_id, vendor_id, storage_key, original_name, mime, size, sha256, uploaded_by, scan_status, archived_at), **file_access_logs**
- **settings**(key, value JSONB, updated_by), **backup_runs**(started/finished, status, size, verified_at, error), **import_batches**/**import_rows**
- Job-queue tables (pg-boss) live in their own schema.

Derived values (status, days, balances, scores) are **computed in one tested service layer**, not stored, to keep one source of truth.

### Status derivation (single primary status + separate flags), evaluated in Asia/Kolkata
Order: Cancelled → Completed (accepted qty ≥ qty sent and no pending inspection, or Admin/Manager closed with reason)
→ Draft (not dispatched) → Commitment Date Missing → Quality Inspection Pending (returned > inspected)
→ Partially Returned (0 < returned < sent) → Overdue (current commitment < today) → Due Today → Due Soon (≤3 days, configurable)
→ In Progress → Sent to Vendor. Flags: `isOverdue`, `delayDays`. Legacy ">10 days pending" kept as a separate "Long Pending" flag.
When qty is NULL, quantity-based statuses are skipped and the job appears in Missing Data Review.

## 8. Vendor reliability score — proposed formulas (all configurable in Settings)
Eligible job = closed (completed, or cancelled **vendor-related**), valid dates. Non-vendor cancellations are excluded entirely.
Each metric uses only the jobs eligible for it; every job counts once per metric, and the score page shows n per metric.
- On-Time % = jobs returned ≤ **original** commitment ÷ jobs with a commitment date. (Q4: original vs latest date.)
- Delay score = max(0, 1 − avgDelayDays ÷ cap) (cap default 14 days)
- Quality % = accepted qty ÷ inspected returned qty (rework counts as not accepted)
- Commitment stability = 1 − min(1, revisions per job ÷ 2)
- Completion time = min(1, category median days ÷ vendor avg days)
- Vendor-cancellation penalty = 1 − vendor-related cancellations ÷ assigned jobs
- Overdue % and rework/rejection % are **displayed** but not separately scored (already inside On-Time and Quality) to avoid double counting.
- Proposed weights: On-Time 30, Quality 25, Delay 15, Stability 10, Completion 10, Vendor cancellation 10 (your 35/25/20/10/10 had no slot for cancellations, Q3).
- Insufficient data: fewer than 5 eligible jobs (configurable) → "Insufficient data", no score.
- Labels: ≥85 Excellent, ≥70 Good, ≥50 Average, else Needs Improvement (editable).
- Recommendation engine (cost comparison) shows price, score, delivery days, quality side by side with a suggested pick and reasons; it never assigns.

## 9. File storage
Private bucket, no public ACL. Upload: API validates extension + MIME + magic bytes + size (default 50 MB), generates UUID key, streams to bucket,
stores metadata + SHA-256. Download: authenticated API call checks permission, logs access, returns a signed URL valid ≤5 min.
Allowed: pdf, xlsx/xls/csv, dxf, dwg, step/stp, sldprt, sldasm, jpg, png (CAD types validated by extension + size since no magic bytes).
Malware scanning: ClamAV container on upload where the host supports it (extra ≈$5–10/month); otherwise files are held `scan_status=unscanned` and flagged — I will not claim scanning that isn't running.
Deletion = archive (`archived_at`); hard purge only by Admin with audit entry.

## 10. Backup and disaster recovery
- Layer 1: provider managed daily backups + PITR (needs paid DB tier).
- Layer 2 (independent): nightly `pg_dump` by the worker → AES-256 encrypted (age/GPG key held outside the host) → bucket at a **different provider**; 30 daily + 12 monthly retention (configurable).
- Files: bucket versioning + nightly sync to the backup provider.
- `backup_runs` records every run; a weekly job restores the latest dump into a scratch DB and runs integrity checks (row counts, FK checks, payment totals) → "verified" only then. Failure → in-app + email alert.
- Targets (proposed): **RPO ≤ 15 min** with PITR (≤ 24 h if only dumps survive); **RTO ≤ 4 h**. Extra cost is the paid DB tier + ~$1/month backup bucket.
- Restore drill on staging is a Phase 9 gate; I will not call backups working until it passes.

## 11. Security plan (summary)
Argon2id; password policy (≥12 chars, breached-password check optional); lockout after 5 failures (15 min) + IP/account rate limits;
TOTP MFA + recovery codes; idle timeout (default 30 min, configurable) + absolute 12 h; logout-all; deactivation/password change revokes sessions;
password reset via emailed one-time token (hashed, 30 min); helmet headers + strict CSP, HSTS; same-origin CORS (allow-list only);
Zod on all inputs, Prisma parameterised queries, React output encoding; per-route permission middleware with a test that fails if any route lacks one;
app DB role with least privilege (no DDL, no UPDATE/DELETE on audit/payments/commitment/inspection tables); TLS to DB; secrets only in host env vars;
`.env` git-ignored + secret scanning in CI; `npm audit`/Dependabot; structured logs with PII/secret redaction; generic errors to users, detail to Admin log.
Security events (failed logins, lockouts, permission changes) feed the Admin System Health & Security page with alerts.

## 12. Deployment plan
Docker image → push to host → release step runs `prisma migrate deploy` after a verified backup → health check `/healthz` → switch traffic.
Rollback: redeploy previous image; destructive migrations avoided (expand/contract) so rollback is safe; PITR as last resort.
Custom domain via CNAME + managed TLS cert. Production checklist produced in Phase 9. I will not say it is live until the production URL is tested from multiple devices.

## 13. Phases (each ends with tests passing and your sign-off)
2 approve this doc → 3 foundation/auth/RBAC/MFA/user mgmt → 4 jobs, vendors, assignments, Excel import/export →
5 commitments, reliability, cost comparison → 6 returns, quality, payments → 7 WhatsApp, reminders, notifications, queue →
8 audit UI, dashboard, weekly reports → 9 deployment, backups, monitoring, restore drill → 10 full testing, security report, handover.
Phases 3–8 run locally/staging with synthetic data. Cloud accounts are only needed at Phase 9 (staging earlier if you want).

## 14. Open questions (blocking)
Q1 Repo: build in `/machining-tracker` here, or a new repo?
Q2 Hosting: approve Option A (Render + Cloudflare R2 + Backblaze B2) or choose B (AWS Mumbai)? No account is created until you say so.
Q3 Scoring weights: accept the 6-factor weights in §8 (adds a cancellation factor), or keep 35/25/20/10/10 and show cancellations as display-only?
Q4 On-time measured against the **original** commitment (my default) or the **latest** revised date?
Q5 MFA: mandatory for all users, or Admin/Manager only?
Q6 Permission matrix in §6: any changes (e.g. should Managers see payments by default)?
Q7 Email provider for password reset/alerts: do you have SMTP (e.g. Google Workspace, since you use cess.co.in) or should I plan a transactional service?
Q8 Expected users and who will be the first Admin account?
