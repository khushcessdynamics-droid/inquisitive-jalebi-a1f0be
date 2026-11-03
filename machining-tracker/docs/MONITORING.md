# Monitoring and logging

What watches the application, where each kind of record is kept, and what to do when something is flagged. Everything here is
on free plans.

## What is watched automatically

| Watch | Checks | Where you see it | How you are told |
|---|---|---|---|
| **System Health page** (Admin) | Database and file space against the free limits; last verified and last failed backup; every scheduled database job (last run, result, runs and failures in 7 days); the reminder engine's last run; the latest weekly report; users and live sessions; rows per table | App → System Health. A **Needs attention** box at the top lists problems | Shown when an Admin opens the page (it refreshes every minute) |
| **Daily live-site check** (`.github/workflows/live-check.yml`) | From outside, every morning at 06:13 IST: HTTPS and security headers, no secret in the website's JavaScript, sign-up off, nothing readable without signing in, private files, Edge Function origin rules | GitHub → Actions → "Daily live-site check" (results on the run's summary page) | GitHub sends an email notification about failed scheduled runs (to the person who last changed the workflow's schedule). Turn it on by adding the three public variables listed at the top of the workflow |
| **Backup tool** (backup PC) | Every backup is test-restored before it is marked verified; failures are recorded | System Health (last verified / last failed); `CESS-Machining-Data\logs` on the PC | The **Needs attention** box when the last verified backup is older than 2 days or the newest attempt failed |
| **CI** (`.github/workflows/ci.yml`) | Every change: type check, all tests, production build, secret scan, dependency vulnerabilities (high/critical) | Pull request checks | A red check on the pull request; the change is not published until it is fixed |
| **Supabase usage emails** | Free-plan quotas | Supabase dashboard → Usage | Supabase emails the account owner when a quota is exceeded |

### What the "Needs attention" box flags

| Problem | Level |
|---|---|
| No verified backup, last verified backup older than 2 days, or the newest backup attempt failed | Critical |
| Database or file storage at 80 % of the plan (critical at 95 %; at 100 % new uploads fail) | Warning / Critical |
| Database scheduler unavailable, a job switched off, its last run failed, or a 15-minute job silent for over an hour | Critical |
| Failed runs in the last 7 days | Warning |
| Today's reminders not run 30 minutes after the configured time | Warning |

## Where records and logs are kept

| Record | Where | Kept for |
|---|---|---|
| Business history: who changed what, previous and new values, reasons, sign-ins, exports, WhatsApp opened, backups and restores | App → Activity History (`activity_log`, append-only) | Permanently; included in every backup |
| Backup runs | System Health; `backup_runs` table; `CESS-Machining-Data\logs` on the backup PC | Permanently (table); the PC logs until deleted |
| Scheduled job runs | System Health (from the database scheduler's run log) | 30 days (cleaned up nightly at 02:47 IST so the log does not use up the free database space) |
| Reminder runs | `reminder_runs` (one row per day) and the Notifications page | Permanently |
| Weekly reports | App → Weekly Reports (`weekly_reports`, permanent) | Permanently |
| API, database and Edge Function logs | Supabase dashboard → Logs | **1 day** on the free plan (auth logs 1 hour) |
| Website deployments and build logs | Cloudflare → Workers & Pages → the project → Deployments | Kept by Cloudflare per deployment |
| Test, deployment and live-check runs | GitHub → Actions | 90 days by default |

No password, sign-in link, secret key or token is ever written to any of these logs.

## When something is flagged

| Flag | What to do |
|---|---|
| Backup old or failed | On the backup PC run `backup-now.cmd`; read the newest file in `CESS-Machining-Data\logs`; see `BACKUP_AND_RECOVERY.md` |
| Space at 80 % | Check which tables or files grew (System Health → Rows per table, file count); plan the upgrade or clean-up in `COSTS.md` before 95 % |
| Scheduled job failing or silent | Read the message in System Health → Scheduled jobs. If the project was paused, restore it in the Supabase dashboard. If a job is missing or off, run the migrations again (`DEPLOYMENT.md`, step 2) |
| Daily live-site check failed | Open the run in GitHub Actions: the summary lists the failed checks. A website header problem usually means a build setting changed in Cloudflare; a Supabase check failing may mean a dashboard setting changed (`CLOUD_SECURITY.md`) |
| Anything security-related | `ADMIN_SECURITY_GUIDE.md` → "If something looks wrong" and `DISASTER_RECOVERY.md` |

## Honest limits

- The free plan gives no uptime alerting with phone calls or SMS. The daily check notices problems within a day, and the System
  Health page shows them immediately when an Admin looks.
- GitHub may switch off scheduled workflows in a public repository after 60 days without any repository activity; re-enable it in
  the Actions tab if that happens (a private repository avoids this).
- Supabase keeps its own logs for one day on the free plan, so investigate API errors the same day.
