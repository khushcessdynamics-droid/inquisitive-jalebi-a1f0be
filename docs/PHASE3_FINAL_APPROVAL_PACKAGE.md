> **SUPERSEDED (2026-11-02):** cloud/multi-user plan replaced by `LOCAL_ARCHITECTURE_PROPOSAL.md` (personal use, local, ₹0 running cost). Kept for history; business rules and formulas here still apply where not overridden.

# CESS Machining Job Tracker — Final Approval Package (before Phase 3 code)

Status: **AWAITING YOUR APPROVAL. No application code written. No paid service purchased, activated or subscribed.**
Supersedes the open items in `PHASE2_ARCHITECTURE_PROPOSAL.md`; unchanged parts of that document still apply.

Your decisions recorded: project in `machining-tracker/` inside this repo (existing files and the original workbook untouched) ·
Render + Cloudflare R2 + Backblaze B2 preferred, AWS Mumbai compared · six-factor score · on-time measured against ORIGINAL commitment ·
MFA mandatory for Admin and Manager, optional for Staff (policy-driven, can be made mandatory for all) · Manager sees payments read-only ·
configurable email provider · no hardcoded users, secure first-Admin setup.

Cost basis: ALL prices are my estimates from general knowledge, converted at an assumed ₹88 per US$1, excluding GST. They are
**not live quotes**. Every figure must be re-checked on the provider's pricing page before you approve a purchase.

---
## 1. Final architecture and hosting plan
```
Browser ──HTTPS──► Render web service (Node/Express serves API + built React app, same origin)
                     ├─► Render PostgreSQL (private connection, TLS)  ← data + sessions + pg-boss job queue
                     ├─► Render background worker (same image) ← reminders, reports, backups, email outbox, retries
                     ├─► Cloudflare R2 (PRIVATE bucket) ← attachments, via short-lived signed URLs
                     ├─► Backblaze B2 (separate provider) ← encrypted nightly DB dumps + file copies
                     └─► Email provider (configurable adapter) · WhatsApp Cloud API (off until configured)
```
- Render has **no India region**; nearest is Singapore (about 60–80 ms from India). AWS Mumbai is the only option here with in-India data residency.
- Code is containerised and uses only standard Postgres and the S3 API, so moving Render → AWS later is a configuration and deployment change, not a rewrite.
- Environments: local dev (Docker Postgres, synthetic data), staging (separate DB/bucket/secrets), production.

### Render + R2 + B2 vs AWS Mumbai (ap-south-1) — estimates, ≤10 users, ≤20 GB files
| Item | Render + R2 + B2 | AWS Mumbai |
|---|---|---|
| App hosting | Web service 1 GB RAM ≈ $7–25 | ECS Fargate/App Runner ≈ $15–30, plus load balancer ≈ $18+ |
| Background worker | ≈ $7 | ≈ $9–15 (second small task) |
| PostgreSQL | Basic plan ≈ $6–19 + ≈ $0.30/GB storage | RDS db.t4g.micro/small ≈ $13–28 + gp3 ≈ $0.12/GB |
| File storage | R2 ≈ $0.015/GB (first 10 GB free) | S3 Mumbai ≈ $0.025/GB |
| Backup storage | B2 ≈ $0.006/GB (first 10 GB free) | S3 (second region/account) ≈ $0.025/GB |
| Bandwidth | R2: no egress fee; Render has monthly included allowance then per-GB | ~100 GB/mo free, then ≈ $0.11/GB |
| Domain + DNS | ≈ ₹1,000/yr (DNS free via Cloudflare) | same (+ Route 53 ≈ $0.50/mo if used) |
| **Initial monthly (est.)** | **≈ $25–55 ≈ ₹2,200–4,800** | **≈ $55–95 ≈ ₹4,800–8,400** |
| Growth: 50 users, 100 GB files, bigger DB | ≈ $70–130 ≈ ₹6,200–11,400 | ≈ $110–200 ≈ ₹9,700–17,600 |
| Free-tier limits | Free web services sleep after idle (would stop reminders); free Postgres is time-limited and has no PITR → **not for production** | 12-month free tier is for new accounts and too small; RDS/Fargate free tier does not cover this setup |
| Database backup/DR | Managed daily backups; PITR depends on paid plan (verify); my independent encrypted dumps to B2 | RDS automated backups + PITR (up to 35 days), snapshots, Multi-AZ optional (~2× DB cost) |
| Security | TLS, private DB networking, secrets in env; fewer knobs | VPC, private subnets, KMS encryption, IAM, CloudTrail; strongest, but I must build and you must maintain more |
| Scalability | Scale by changing plan; adequate for this workload | Highest ceiling; more operational effort |
| Data residency | Singapore | **India** |

Recommendation unchanged: start on **Render + R2 + B2** for simplicity and cost; choose AWS Mumbai if data must stay in India or
you expect rapid growth. Production never runs on free tiers. Email, WhatsApp API and optional malware scanning (ClamAV, ≈ $5–10/mo) are extra, see §7.

## 2. Final database design (PostgreSQL + Prisma)
Conventions: UUID PKs · `created_at/updated_at` · `version` integer (optimistic locking, 409 on stale write) · `deleted_at` soft delete on business tables ·
money as `NUMERIC(14,2)` · business dates `DATE`, event times `TIMESTAMPTZ` · all “today” logic in Asia/Kolkata · FKs everywhere · `pg_trgm` index on part label.

**Identity and access**
- `users`(email uniq, name, password_hash [Argon2id], role_id, is_active, linked_given_by_id NULL, mfa_enabled, mfa_secret_enc, failed_logins, locked_until, last_login_at, password_changed_at, invited_by)
- `roles`(key, label, mfa_required bool — policy default Admin/Manager true, Staff false), `permissions`(key), `role_permissions`(role_id, permission_key), `user_permission_overrides`(user_id, permission_key, granted bool, granted_by, reason)
- `sessions`(id hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa_verified bool, scope `full|mfa_enrollment`, revoked_at)
- `invitations`(email, role_id, token_hash, expires_at, accepted_at, invited_by), `password_resets`(user_id, token_hash, expires_at, used_at), `mfa_recovery_codes`(user_id, code_hash, used_at), `login_attempts`(email, ip, success, at)

**Master data**
- `vendors`(vendor_code uniq, company_name, contact_person, mobile, wa_country_code default +91, wa_number, wa_opt_in_at, email, address, gst_no, payment_terms, remarks, is_active), `vendor_categories`(vendor_id, work_category_id)
- `work_categories`, `given_by_names` (seeded from workbook: 11 categories, Samyak/Vansh/Sanjay; editable by Admin)
- `cancel_reason_codes`(code, label, **vendor_related bool**, vendor_subtype `delivery|refusal|incomplete|quality|repeated_commitment|null`, is_active) — seeded with your vendor and non-vendor lists; Admin may add reasons but each must be classified.

**Jobs**
- `jobs`(job_no uniq `JOB-2627-0001`, **part_label** one combined “Part No / Part Name” field, description, qty_sent NULL, category_id, given_by_id, date_given, estimated_amount, remarks, closed_reason, closed_by)
- `job_assignments`(job_id, sequence_no, vendor_id, parent_assignment_id, dispatched_on, qty_sent NULL, amount, **original_commitment_date NULL (immutable, trigger-enforced)**, current_commitment_date NULL, state `open|completed|cancelled`, cancelled_on, cancel_reason_code, cancel_reason_text **NOT NULL when cancelled**, forwarded_to_assignment_id). Unique (job_id, sequence_no); partial unique index = one open assignment per job.
- `commitment_history` (append-only): assignment_id, revision_no, original_date, previous_date, new_date, changed_at, changed_by, reason
- `material_returns`(assignment_id, qty_received, returned_on, received_by, remarks) · `quality_inspections`(return_id, inspected_on, inspected_by, accepted_qty, rejected_qty, rework_qty, status, remarks, supersedes_id) — corrections add a row, never edit. CHECK accepted+rejected+rework ≤ qty_received.
- `payments`(assignment_id, kind `advance|payment|reversal`, amount, paid_on, mode, txn_ref, remarks, created_by, reverses_id, idempotency_key) — **no UPDATE/DELETE**; unique (assignment_id, mode, txn_ref) when txn_ref present; `payment_adjustments`(assignment_id, additional_charges, discount, by, at, supersedes_id)
- `vendor_quotations`, `attachments`(job_id, assignment_id, vendor_id, storage_key, original_name, mime, size, sha256, scan_status, uploaded_by, archived_at), `file_access_logs`

**Automation, comms, audit, ops**
- `whatsapp_templates`, `whatsapp_messages`(mode, status queued→accepted→sent→delivered→read/failed, provider_msg_id, dedupe_key uniq, initiated_by)
- `reminders`(assignment_id, rule_key, due_on; unique triple), `notifications`(user_id, type, ref, read_at)
- `email_outbox`(template_key, to_email, payload JSONB redacted, status queued/sent/failed, provider_msg_id, attempts, last_error)
- `activity_logs` — append-only (trigger blocks UPDATE/DELETE; app DB role has INSERT/SELECT only): actor id+name, action, module, job_id, vendor_id, previous/new JSONB, reason, ip, session_id, at. Also holds security events (logins, lockouts, permission and MFA changes).
- `weekly_reports`, `settings`(key, value JSONB, updated_by), `scoring_config` (inside settings, versioned), `backup_runs`(started, finished, status, size, checksum, verified_at, error), `import_batches`, `import_rows`; pg-boss schema for the queue.

Derived values (status, days, balances, scores) come from one tested service layer, never stored duplicates.

## 3. Final six-factor reliability formula — PROPOSAL FOR YOUR APPROVAL
**Proposed sixth factor: Vendor-Caused Cancellation, weight 10%.** Your five weights must give up 10 points in total. Two options:

| Factor | Your original | **Option 1 (recommended)** | Option 2 (smaller cuts) |
|---|---|---|---|
| On-time delivery | 35 | **30** | 32 |
| Quality | 25 | **25** | 23 |
| Delay performance | 20 | **15** | 18 |
| Commitment stability | 10 | **10** | 9 |
| Completion time | 10 | **10** | 8 |
| Vendor-caused cancellation | – | **10** | 10 |
| Total | 100 | **100** | 100 |
Option 1 takes the points from on-time and delay, because a vendor-caused cancellation is usually a severe delivery failure. All weights stay editable in Settings.

**Score = Σ (weight × factor score 0–100)**, computed per vendor, optionally per category / financial year / date range.

**Assignment buckets — each assignment counts in exactly one bucket (no double counting):**
- **Completed** (closed, valid data): feeds on-time, delay, stability, completion time.
- **Vendor-caused cancelled** (reason code with `vendor_related = true`): feeds ONLY the cancellation factor; excluded from the four delivery factors.
- **Excluded**: non-vendor cancellations (customer cancelled, internal planning, production change, no longer required, other), open jobs, and jobs lacking required data for that metric.
- Quality is counted by pieces from inspections on completed assignments. Inspections on an assignment cancelled for the *quality* reason are excluded from the Quality factor so that one failure is not counted twice.

**Factors (all against the ORIGINAL commitment date):**
1. **On-time % (incidence)** = completed assignments returned on/before `original_commitment_date` ÷ completed assignments with an original commitment date. Missing commitment date → excluded.
2. **Delay performance (severity)** = measured only on the *late* completed assignments: `100 × (1 − min(1, avg late days ÷ cap))`, cap default 14 days. If none were late → 100. (On-time = how often late; delay = how late when late.)
3. **Quality %** = accepted qty ÷ inspected returned qty (rework counts as not accepted). Uninspected pieces excluded and shown as pending.
4. **Commitment stability** = `100 × (1 − min(1, revisions per completed assignment ÷ 2))`.
5. **Completion time** = `100 × min(1, category median days ÷ vendor avg days)`; days = dispatch to final return; median across all vendors’ completed assignments in that category. No median available → excluded.
6. **Vendor-caused cancellation** = `100 × (1 − vendor-caused cancellations ÷ (completed + vendor-caused cancelled))`.

**Insufficient history:** fewer than 5 eligible assignments for the vendor (Settings, default 5) → shows “Insufficient data (n of 5)” and **no score**. A factor with no eligible jobs is omitted and the remaining weights are renormalised, shown explicitly on screen; if fewer than 3 factors remain, no score is shown.
**Labels:** ≥85 Excellent · 70–84.9 Good · 50–69.9 Average · <50 Needs Improvement (editable).
**Displayed beside the score (not separately scored):** overdue-job %, rework/rejection %, count of jobs used per factor, the cancellation count with reasons broken out by code, original-vs-actual and revised-vs-actual delay per job, revision count, total delay days.
**Known, documented overlap:** completion time and on-time both reflect slow vendors; stability penalises changing promises, which is a different behaviour from being late. Weights are the control for this.
**Transparency:** a “How this score was calculated” panel lists every job counted in each factor.

## 4. Final permission matrix (enforced per route on the backend; test fails if any route lacks a permission check)
✔ allowed · ◐ restricted · ✘ denied · Admin can grant/revoke any cell per role or per user (audited).
| Permission | Admin | Manager | Staff/Operator |
|---|---|---|---|
| jobs.view | ✔ all | ✔ all | ◐ assigned or created by them, or granted |
| jobs.create | ✔ | ✔ | ✔ |
| jobs.edit | ✔ | ✔ | ◐ permitted operational fields on their jobs |
| jobs.archive | ✔ | ✘ | ✘ |
| vendors.view | ✔ | ✔ | ◐ name, category, contact only |
| vendors.manage | ✔ | ✔ | ✘ |
| assignments.change (reassign/forward) | ✔ | ✔ | ✘ |
| commitments.change | ✔ | ✔ | ✘ (can view history of their jobs) |
| jobs.cancel | ✔ | ✔ | ✘ |
| reliability.view / costcompare.view | ✔ | ✔ | ✘ |
| returns.record | ✔ | ✔ | ◐ if granted |
| quality.manage | ✔ | ✔ | ✘ |
| payments.view | ✔ | ✔ **view-only default** | ✘ unless Admin grants |
| payments.add | ✔ | ✘ unless Admin grants | ✘ |
| payments.edit / reverse / delete | ✔ (reversal entries only, never silent edits; no hard delete) | ✘ | ✘ |
| financial settings | ✔ | ✘ | ✘ |
| reports.view / reports.export | ✔ | ✔ | ✘ |
| attachments.upload / download | ✔ | ✔ | ◐ on permitted jobs |
| whatsapp.send | ✔ | ✔ | ◐ if granted |
| activity.view | ✔ all | ✘ unless granted | ✘ |
| users.manage / roles & permissions | ✔ | ✘ | ✘ |
| settings.change / backups / system health | ✔ | ✘ | ✘ |
“Assigned” for Staff = the user is linked to a Given By name that matches the job, or created the job, or was explicitly assigned. Please confirm (Q2).
Manager payment visibility: you said view by default; I keep `payments.add` off for Managers unless Admin grants it, since your rule keeps payment editing Admin-only. Confirm (Q3).

## 5. Authentication and MFA design
- Argon2id hashing, minimum 12 characters, common-password blocklist. Lockout after 5 failed logins (15 min) plus per-IP and per-account rate limits; all attempts logged.
- Opaque server-side session in an HttpOnly, Secure, SameSite=Lax cookie; CSRF double-submit token; idle timeout (default 30 min, configurable), absolute lifetime 12 h; “log out everywhere”; deactivation, password change, MFA reset and role change revoke sessions immediately.
- **MFA policy lives in settings per role** (`mfa_required` for roles: Admin, Manager = true; Staff = false). Flipping Staff to true later forces enrollment at next login with no code changes. Authenticator app (TOTP) plus 10 single-use recovery codes (hashed); secret stored encrypted with a key from env.
- Users whose role requires MFA but who haven’t enrolled get a limited `mfa_enrollment` session that can only complete enrollment. Staff get a persistent banner recommending MFA.
- Password reset by emailed single-use token (hashed, 30 min). Reset does NOT bypass MFA.
- Admin can reset another user’s MFA (audited, sessions revoked). Last-Admin lockout recovery: server-side CLI `npm run admin:reset-mfa -- --email` run by someone with host access. No remote backdoor.
- **First Admin bootstrap:** `npm run admin:create -- --email <company address>` run once on the server. It refuses if any user exists, prints a one-time setup link (token stored hashed, expires in 60 min) and never accepts or stores a password on the command line or in source. The Admin sets a password and enrolls MFA in the browser. The email comes from you at that time; nothing is invented or hardcoded.
- **Invitations:** Admin enters email + role; an emailed single-use link lets the invitee set a password and enrol MFA if required. No user limit anywhere.

## 6. Email provider integration plan
Provider-agnostic `EmailProvider` interface, adapters: generic **SMTP (nodemailer)**, plus API adapters added only if you choose one. Config lives in env vars (`EMAIL_PROVIDER`, `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`, API keys); Settings shows status, never the secret. All sends go through `email_outbox` with retries; templates: password reset, invitation, security notice, weekly report (off by default). Until a provider is configured, the app says clearly that email is disabled; password reset and invitations won’t be sent. In dev, emails go to a local log/Mailpit inbox.

Provider comparison (estimates, verify; India sender-domain setup SPF/DKIM/DMARC needed for all):
| Provider | Free tier (approx.) | Paid (approx.) | Notes |
|---|---|---|---|
| Brevo | ~300 emails/day | from ≈ $9/mo | easy SMTP |
| Resend | ~3,000/mo, ~100/day | ≈ $20/mo | developer-friendly API |
| Amazon SES (Mumbai) | none beyond small allowances | ≈ $0.10 per 1,000 | cheapest at scale; needs AWS account and sandbox exit |
| Zoho ZeptoMail | trial credits | ≈ $2.5 per 10k emails | cheap transactional |
| Postmark | 100/mo | ≈ $15/mo for 10k | best deliverability reputation |
| Google Workspace SMTP relay | included if you have it | – | daily limits; only if you confirm credentials — **not assumed** |
For roughly 10–50 users, volume is a few hundred emails a month, so a free tier suffices. My suggestion: Brevo or Resend free tier to start. Nothing is created until you approve.

## 7. Monthly cost estimate (Render + R2 + B2, ₹88/US$, excl. GST; verify before approval)
| Line | Initial (≤10 users, <20 GB) | Grown (50 users, 100 GB) |
|---|---|---|
| Frontend hosting | ₹0 (served by backend) | ₹0 |
| Backend web service | ₹600–2,200 | ₹2,200–4,400 |
| Background worker | ₹600 | ₹600–2,200 |
| PostgreSQL | ₹500–1,700 | ₹1,700–4,400 |
| R2 file storage | ₹0–100 | ₹100–150 |
| B2 backup storage | ₹0–100 | ₹100–300 |
| Domain | ~₹85 (₹1,000/yr) | ~₹85 |
| Email | ₹0 (free tier) | ₹0–800 |
| Monitoring/error logging | ₹0 (free tiers) | ₹0–2,300 |
| Malware scanning (optional) | ₹0–900 | ₹900 |
| WhatsApp Cloud API | ₹0 until enabled; then per-conversation Meta charges | usage-based |
| **Total** | **≈ ₹2,200–4,800** | **≈ ₹6,200–11,400** |
Free tiers not suitable for production (sleeping services, expiring DB, no PITR). No service is bought until you approve the specific provider and plan.

## 8. Backup, restore and disaster recovery
- **Layers:** (1) managed DB backups + PITR on a paid plan (to be verified for the chosen plan); (2) nightly encrypted `pg_dump` (AES-256 via age; key kept outside the host and recorded by you) to B2; (3) R2 versioning + nightly sync of files to B2. Retention default: 30 daily, 12 monthly, configurable. Admin can trigger a manual backup.
- **Monitoring:** every run recorded in `backup_runs` with size/checksum; failure raises an in-app alert and email (if email configured). The System Health page shows last success and last failure.
- **Verification:** weekly automated restore of the latest dump into a scratch database, with integrity checks (row counts, FK validity, payment totals reconcile with ledger, audit rows intact). A backup is shown as “verified” only after this passes. “Scheduled” is never displayed as “working”.
- **Targets (proposed):** RPO ≤ 15 min with PITR (worst case ≤ 24 h from nightly dumps); RTO ≤ 4 h. Extra cost: paid DB plan with PITR + ~₹100/month backup storage. Stricter targets (e.g. RTO 1 h with a warm standby) roughly double the DB cost.
- **Runbooks:** database restore (PITR and dump), file restore, full-site recovery on a new Render/AWS account, key-loss procedure, quarterly drill on staging. Backup testing on staging is a Phase 9 gate before declaring backups complete.

## 9. What I will build in Phase 3 once approved (scope preview)
Monorepo `machining-tracker/` (`apps/api`, `apps/web`, `packages/shared`), Docker Compose for local Postgres + Mailpit, Prisma schema + first migrations for identity/RBAC/audit/settings tables, seed of roles/permissions/categories/Given By names (no users, no fake data), auth (login/logout/sessions/lockout/rate limit/CSRF), TOTP MFA with policy, invitations, password reset, first-Admin CLI, user & permission management UI, app shell with sidebar, audit logging of security events, CI (lint, typecheck, tests, `npm audit`, secret scan), and automated tests for each security rule. Business modules come in Phase 4 onward.

## 10. Questions that need your answer
Q1 Approve the six-factor weights: **Option 1 (30/25/15/10/10/10)** or Option 2 (32/23/18/9/8/10), or give your own numbers.
Q2 Confirm Staff “assigned jobs” definition (§4).
Q3 Confirm Managers get `payments.view` only (no add) by default.
Q4 Confirm that I should create `machining-tracker/` as a new folder in this repo.
Q5 Confirm the cost/hosting direction (Render + R2 + B2 for now). This approves planning only; I will ask again with exact plans before any account is opened.
Q6 Email: any preference among Brevo / Resend / SES / ZeptoMail, or decide later? (App works without it, but invitations and password reset need it.)
Q7 When ready, the company email address for the first Admin (not needed until deployment/setup).
