# Disaster recovery plan

What to do when something goes wrong, who does it, and how much can be lost. The backup tool and the restore procedures are described
step by step in `docs/BACKUP_AND_RECOVERY.md`; deployment in `docs/DEPLOYMENT.md`.

## Targets (free setup)

| | Target |
|---|---|
| Data that can be lost (recovery point) | Up to 24 hours with the daily backup at 21:00. Run `backup-now.cmd` before risky work |
| Time to be working again (recovery time) | Same project: about 15–30 minutes. New Supabase project: about 1–2 hours |
| Where recovery copies live | `C:\Users\<you>\CESS-Machining-Data\backups` (outside OneDrive) plus the second copy on a USB / external drive |

What is in a backup: every application table (jobs, assignments, vendors, returns, inspections, invoices, payments and reversals,
quotations, WhatsApp log, reminders, weekly reports, settings, activity history), user accounts with password hashes and MFA secrets,
and every attachment file. Every backup is encrypted and is proven restorable by a test restore before it is marked **verified**.
A complete loss of the database followed by a restore of all business records is tested automatically
(`tests/integration/phase10-restore.test.ts`, `tests/integration/backup.test.ts`).

## Scenarios

| # | What happened | Do this | Who |
|---|---|---|---|
| 1 | A record was entered wrongly | Correct it in the app. Payments and returns are corrected with a reversal or void with a reason; the history keeps both | User with the permission |
| 2 | Many records were damaged (wrong import, mistaken bulk change) | Stop work. Run `backup-restore.cmd` with the last good verified backup (procedure A). A safety backup of the current state is taken first, so the restore can be undone; the activity history is never rolled back | Admin |
| 3 | The Supabase project is paused (no use for 7 days) | Supabase dashboard → the project → **Restore project**. Data is kept. Scheduled reminders do not run while paused | Admin |
| 4 | The Supabase project is lost, deleted or unusable | Procedure B in `BACKUP_AND_RECOVERY.md`: new free project (Mumbai), apply the migrations (`DEPLOYMENT.md` step 2), restore the newest verified backup, deploy the Edge Function, point the website at the new project and redeploy. Everyone signs in with their existing password and authenticator | Admin |
| 5 | The website (Cloudflare) is down or the account is lost | Data is not affected (it is in Supabase). Create a new Cloudflare Pages project from the same GitHub repository (`DEPLOYMENT.md` step 4), then update the Supabase Site URL, redirect URL and `APP_SITE_URL` / `APP_ALLOWED_ORIGINS` if the address changed | Admin |
| 6 | The backup PC is broken or stolen | Install the backup tool on another PC, copy `backup.key` and the backups from the USB copy into the new `CESS-Machining-Data` folder, and run `backup-verify.cmd`. If the PC was stolen, also do scenario 9: the backups are encrypted, but the PC may hold the secret key in `backup.json` | Admin |
| 7 | The backup key is lost | Old backups cannot be opened by anyone. Create a new key (`backup-setup.cmd`), keep two copies, and run `backup-now.cmd` at once. Keep the old backups until the new ones are verified | Admin |
| 8 | An Admin or Manager account may be compromised (lost phone, shared password) | Another Admin deactivates the account at once (it stops working immediately, even if signed in), checks the activity history for that person, then reactivates, uses **Reset authenticator** and sends a **Password reset link**, so the person sets a new password and a new authenticator. If the last Admin is affected, use the Supabase dashboard (`ADMIN_SECURITY_GUIDE.md`) | Admin |
| 9 | A secret may have leaked (Supabase secret key, database password, access token) | Supabase dashboard: **rotate** the secret key (API Keys), **reset** the database password (Database settings), **revoke** access tokens (Account → Access Tokens). Update `backup.json` on the backup PC and the GitHub secrets. The website needs no change (it only has the public key) | Admin |
| 10 | GitHub is unavailable or the repository is deleted | The live app keeps running (Cloudflare and Supabase have their own copies). Restore the code from any clone (the backup PC has one if the tool was installed from Git) | Admin |

## Practising

- **Every quarter:** restore the newest backup into a spare free Supabase project (procedure B) and sign in. Delete the spare project
  afterwards (the free plan allows 2 active projects).
- **Every month:** open **System Health** in the app and check the date of the last verified backup; check that the USB copy is current.

## Honest limits

- Backups run only when the backup PC is on. If it is off for a week, there is no backup for that week.
- Supabase Free has no point-in-time recovery. Changes made after the last backup and before a total loss cannot be recovered.
- A project owner with full database access could switch off the protective triggers; keep the Supabase account to the Admin, with MFA.
