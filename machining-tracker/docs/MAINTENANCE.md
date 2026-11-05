# Application maintenance guide

How the application is kept running, changed and updated. Day-to-day Admin tasks (users, permissions, checks):
`ADMIN_SECURITY_GUIDE.md`. Watching for problems: `MONITORING.md`. Emergencies: `DISASTER_RECOVERY.md`.

## Where everything lives

| Part | Where | Changed by |
|---|---|---|
| Code, database structure (migrations), tests, documents | GitHub repository, folder `machining-tracker/` | A developer, through pull requests |
| Website | Cloudflare Pages, built automatically from the `main` branch | Merging into `main` |
| Data, sign-in, files, Edge Function, scheduled jobs | Supabase project | The app; migrations; the Supabase dashboard for settings |
| Backups and the backup key | The backup PC, `C:\Users\<you>\CESS-Machining-Data` (outside OneDrive) and the USB copy | The backup tool |
| Business settings (reminders, templates, weekly report, reliability weights, master lists, session timeouts) | App → Settings | Admin, no code change |

## Routine

| When | Task |
|---|---|
| Daily (automatic) | Backup on the backup PC at 21:00; reminders at 09:00 IST; daily live-site check at 06:13 IST |
| Weekly | Look at System Health → **Needs attention**; Activity History for unusual changes |
| Monthly | `npm outdated` for updates (below); check the USB backup copy; review users and roles |
| Quarterly | Restore drill (`DISASTER_RECOVERY.md`); review free-plan usage against `COSTS.md` |
| Yearly | Rotate the Supabase secret key and update `backup.json` on the backup PC; renew GitHub access tokens if used; check `FREE_TIER_VERIFICATION.md` against the providers' current pages |

## Changing the application

1. Make the change on a new branch and open a pull request. Every pull request runs all checks (`ci.yml`): type check, unit,
   database, browser and production-build tests, the secret scan and the vulnerability gate. Do not merge while a check is red.
2. **Database changes** are new files in `supabase/migrations/` (never edit a migration that is already on the live project).
   Keep them additive (new columns or tables, new functions) so the current website keeps working while the new one is published.
3. Before publishing a change that touches the database: run `backup-now.cmd` on the backup PC.
4. Apply the database change first: GitHub → Actions → **Deploy to Supabase** → choose the pull request's branch → type `DEPLOY`.
   Already-applied migrations are skipped.
5. Merge the pull request. Cloudflare publishes the new website within a few minutes.
6. Check System Health and run the deployment checker (`DEPLOYMENT.md`, step 7) if security-related files changed.
7. If permissions or tables changed, regenerate the security documents on a developer PC (`node scripts/security-docs.mjs` after
   `npm run db:reset`) and commit them.

## Undoing a bad change

| Problem | Undo |
|---|---|
| The new website misbehaves | Cloudflare → the project → **Deployments** → All deployments → "…" on the previous production deployment → **Rollback to this deployment**. Instant; any successfully built production deployment can be chosen |
| A database change was wrong | Migrations are not undone automatically. Write a new migration that corrects it and publish it the same way |
| Data was damaged by a change | Restore the backup taken in step 3 (`BACKUP_AND_RECOVERY.md`, procedure A); the restore keeps the activity history |

## Updates

| Item | How | Note |
|---|---|---|
| npm packages | `npm outdated`, then update in a branch (`npm install <package>@<version>`) and let CI test it | CI fails on any high or critical vulnerability; see `DEPENDENCY_VULNERABILITIES.md` |
| Supabase CLI | Version pinned in `package.json` (`supabase`), update like a package | Used for migrations and the Edge Function deployment |
| Node.js | The build uses Node 22 (`NODE_VERSION` in Cloudflare, `node-version` in the workflows) | Node 22 is supported until April 2027; move to the next long-term version before then, in all three places |
| Supabase / Cloudflare features | Watch their email announcements | Supabase is retiring the old `anon` / `service_role` keys; the app already uses the new publishable / secret keys |

## Free-plan limits to keep in mind

Database 500 MB, file storage 1 GB (files up to 50 MB each), the project pauses after 7 days without use, logs kept 1 day. System
Health warns at 80 %. What to do when a limit comes close, and what it costs: `COSTS.md`.

## Running everything on a developer PC

See `README.md` ("Local development" and "Tests"): Node 22, Docker, `npm ci`, `npm run db:start`, then `npm run dev`. All test
commands reset only the local database and refuse anything else.
