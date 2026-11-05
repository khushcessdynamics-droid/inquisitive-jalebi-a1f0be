# Backup and recovery

Supabase Free does **not** include automatic backups or point-in-time recovery. This tool fills that gap at no cost. It runs on your
Windows PC, keeps encrypted copies of everything in `C:\Users\<you>\CESS-Machining-Data`, proves every backup can be restored, and can
restore the whole application, including after a complete loss of the Supabase project.

## What is backed up
| Included | Not included (on purpose) |
|---|---|
| Every table of the application (jobs, vendors, payments, settings, activity history, ...). New tables added in later phases are included automatically | Live sessions and one-time tokens (everyone simply signs in again after a restore) |
| User accounts: email, password hash, MFA authenticator secrets, passkeys / recovery codes if used, Supabase sign-in history | Supabase's own internal version tables |
| All attachment files (drawings, PDFs, photos) with their bucket settings | The application code (it is in GitHub) and the database structure (re-created from the migrations in GitHub) |

Because the backup contains password hashes and MFA secrets, **every backup is encrypted** (AES-256-GCM). The key lives in
`CESS-Machining-Data\keys\backup.key`. **Keep a second copy of the key** (USB drive, password manager, or printed and locked away). Without it no
backup can be opened, and with it anyone holding a backup file could read it.

## How a backup is made and verified
1. One consistent, read-only snapshot of the database is taken (all tables from the same instant), and the attachment files are downloaded.
2. Everything is packed, compressed and encrypted into one file, for example `cess-backup_2026-11-02_210000_scheduled.cbk`. Nothing readable is written to disk.
3. **Verification by test restore.** The file is decrypted (any change to the file is detected), every table is loaded into a separate
   PostgreSQL test database that runs inside the tool (PGlite; nothing to install), and:
   - the row counts are compared;
   - primary keys, unique keys and every relationship are rebuilt, so duplicates or orphan records fail the check;
   - every table is exported again and must be **byte-identical** to the backup;
   - business checks taken at backup time are compared: active Admins, every account has a profile, size of the activity history,
     settings, MFA factors, and the business records (vendors; jobs and the last job number; vendor assignments by state and their
     amounts; commitment revisions; returned, accepted, rejected and rework quantities; payments with their total and last number;
     adjustments; quotations; WhatsApp log; weekly reports; attachments);
   - every attachment is compared with its checksum.
4. Only then is the backup marked **VERIFIED**. The result is shown on the app's **System Health** page (Admin) and written to
   `CESS-Machining-Data\logs`.
5. Optional second copy (USB / external drive / any folder) is written and checked.
6. Old backups are removed by the retention rules below. This happens only after a new verified backup exists.

## Retention (never deletes your only good backup)
Default: 14 daily, 8 weekly, 12 monthly verified backups (configurable in `backup.json`). Always kept regardless of settings:
- the newest verified backup;
- at least 3 verified backups (`minVerified`);
- safety backups made before a restore, for 90 days;
- failed attempts for 7 days (for diagnosis).

File names include date and time and are never reused. An existing backup file is never overwritten.

## One-time setup on Windows
1. Install **Node.js 22 LTS** from https://nodejs.org (free).
2. Get the project folder (GitHub → Code → Download ZIP, or `git clone`) and keep it outside OneDrive.
3. Double-click `machining-tracker\scripts\windows\backup-setup.cmd`. It creates:
   - `C:\Users\<you>\CESS-Machining-Data\keys\backup.key`: **copy this to a USB drive or your password manager now**
   - `C:\Users\<you>\CESS-Machining-Data\config\backup.json`: fill it in (next step)
4. Edit `backup.json` (Notepad):
   | Field | Value |
   |---|---|
   | `projectLabel` | your Supabase project ref |
   | `supabaseUrl` | `https://<ref>.supabase.co` |
   | `databaseUrl` | Supabase → **Connect** → **Session pooler** connection string (IPv4), with your database password |
   | `sslRootCert` | download the certificate from Supabase → Database settings → SSL configuration, save it as `config\supabase-ca.crt` |
   | `serviceKey` | Supabase → Project Settings → API keys → secret key |
   | `secondCopyDir` | optional, for example `E:\CESS-Backups` (USB drive) or a OneDrive folder (the files are encrypted) |
   This file contains secrets: it stays only on this PC, never in Git, email or chat.
5. Double-click `backup-now.cmd`. It should end with **"Backup finished and VERIFIED"**.
6. Double-click `backup-schedule.cmd` and choose a time (default 21:00). Windows Task Scheduler then runs the backup every day. If the PC
   is off at that time, it runs as soon as the PC is back on. Remove it with `backup-unschedule.cmd`.

The live working folder and the main backup folder must **not** be inside OneDrive, Google Drive or Dropbox; the tool refuses such folders.

## Restoring
### A. Undo a mistake / corruption (same Supabase project)
Double-click `backup-restore.cmd`, choose the backup, and type the confirmation text shown (`RESTORE <project-ref>`). The tool then:
1. verifies the backup again;
2. **takes a safety backup of the current data** (so the restore itself can be undone);
3. checks the database structure version matches the backup;
4. replaces all data **in one transaction**: row counts and every relationship are checked before anything is committed; if anything
   fails, nothing changes;
5. **keeps the activity history entries recorded after the backup** and adds a "Data restored" entry, so the history is never rolled back;
6. uploads the attachment files again (files added after the backup are kept, not deleted);
7. signs everyone out (same passwords and authenticator apps keep working).

### B. Disaster recovery (Supabase project lost or deleted)
1. Create a new Supabase project and apply the migrations (`docs/DEPLOYMENT.md`, steps 1–3), using the **same app version** as the
   backup (the backup records its structure version and the restore refuses a mismatch).
2. Put the new project's details into `backup.json` (keep the same `backup.key`).
3. Run `backup-restore.cmd` and pick the newest verified backup (from the PC or the USB copy, after copying it into the backups folder).
4. Deploy the Edge Function and point the website to the new project (`VITE_SUPABASE_URL`, publishable key) and redeploy.
5. Everyone signs in with their existing password and authenticator app.

This full procedure is tested automatically: the local database is wiped completely, then everything is restored and an Admin signs in
with the original password and MFA code (`tests/integration/backup.test.ts`). The same is tested with a complete set of business
records (jobs with a reassignment, revised dates, returns, inspections, invoice, payments with a reversal, quotations, WhatsApp log,
reminders, weekly report, a drawing): after the restore every screen's data is identical, payments and history still cannot be
altered, and job and payment numbers continue without duplicates (`tests/integration/phase10-restore.test.ts`).
The full emergency plan, including lost keys, lost PC and leaked secrets: `docs/DISASTER_RECOVERY.md`.

## Recovery targets (free setup)
| | Target | Notes |
|---|---|---|
| Recovery point (data you could lose) | **up to 24 hours** with the daily schedule | Run `backup-now.cmd` before risky changes; schedule more often if needed |
| Recovery time | **about 30-60 minutes** | Same-project restore takes minutes; a new project needs setup steps 1-4 above |
| Off-site protection | second copy on USB / external drive | Without a second copy, a PC failure or theft can lose the backups |

## Checking that backups keep working
- **System Health** in the app shows the last verified backup and the last failure.
- `backup-list.cmd` lists all backups with their status; `backup-verify.cmd` re-checks the newest one.
- Once a quarter, run a restore drill into a spare free Supabase project (procedure B) to practise.

## Honest limitations
- Backups run only when the PC is on (a missed run happens at the next start-up). If the PC is off for a week, there is no new backup for
  that week. Supabase also pauses free projects after 7 days without activity.
- The connection to the hosted Supabase database (session pooler + certificate) can only be tested once your Supabase project exists;
  everything else is tested against the local Supabase stack.
- The tool keeps the test database in memory; this suits the 500 MB free-plan database.
