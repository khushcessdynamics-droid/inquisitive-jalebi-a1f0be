# Deploying the app (Phase 9)

**Status: prepared and tested on a local copy. Not deployed yet.** The app is deployed only when you have created the
accounts below and the checks in step 7 pass against the public HTTPS address.

```
Browser ──HTTPS──> Cloudflare Pages (the website: static files only, security headers)
   │
   └──HTTPS──> Supabase (sign-in + MFA, Postgres with row security, private file storage,
                         user-admin Edge Function, scheduled reminders and weekly report)
```

Everything here is on free plans with no payment card. Do not add a card to Supabase, so nothing can ever be charged.
Menu names in the dashboards change from time to time; the setting names are given so you can search for them.

## What you will create, and what you send me

| Account | Cost | Card? |
|---|---|---|
| Supabase (supabase.com), Free plan | ₹0 | No |
| Cloudflare (cloudflare.com), Free plan | ₹0 | No |
| GitHub (you have it) | ₹0 | No |

| Send me (not secret) | Never send to anyone, never put in Git or chat |
|---|---|
| The website address, e.g. `https://cess-machining-tracker.pages.dev` | The database password |
| The project URL `https://<ref>.supabase.co` | The secret key (`sb_secret_…`) or `service_role` key |
| The publishable key (`sb_publishable_…`) | The Supabase access token (`sbp_…`), the Turnstile secret key |

## Before you start: the GitHub repository is public

Anyone can read this repository today. No password, key or business record is in it: the app keeps data only in Supabase,
and backups go to your PC. But `legacy/CESS_Machining_Job_Tracker.xlsx` (the empty template, which lists three staff first
names and the work categories) and all documentation can be read by anyone. Recommended: **make the repository private** in GitHub →
Settings → General → Danger Zone → Change visibility. Cloudflare Pages and GitHub Actions both work with a private repository
(GitHub gives 2,000 free Actions minutes a month for private repositories; one full test run takes about 15 minutes, and
without a payment method GitHub stops the runs instead of charging).

## 1. Create the Supabase project

1. Sign up at supabase.com (Free plan). Create an organisation on the **Free** plan.
2. **New project**:
   - Name: `cess-machining-tracker`.
   - Database password: press **Generate a password**, and save it in a password manager.
   - Region: **South Asia (Mumbai)**.
   - Keep the default security options (Data API on).
3. When the project is ready, open **Project Settings → API Keys** and copy the **Publishable key**. Copy the **Project URL** from
   **Project Settings → Data API** (or the Connect button).
4. The Free plan allows 2 active projects. Free projects are **paused after 1 week without activity**: data is kept, and you
   restore the project from the dashboard. Daily use by the team keeps it active.

## 2. Load the database and the user-admin function

The website address is needed here. Cloudflare Pages addresses are `https://<project-name>.pages.dev`, so with the project
name `cess-machining-tracker` (step 4) it is `https://cess-machining-tracker.pages.dev`. If Cloudflare shows a different
address in step 4, use that one everywhere and run this step again.

### 2A. From GitHub (nothing to install; recommended)

The workflow appears in GitHub's Actions tab only after this work has been merged into `main` (pull request #1).
1. Supabase → your avatar → **Account preferences → Access Tokens** → **Generate new token**, name `GitHub deploy`. Copy it.
2. GitHub → this repository → **Settings → Secrets and variables → Actions**:
   - **Secrets** tab → New repository secret: `SUPABASE_ACCESS_TOKEN` (the token), `SUPABASE_DB_PASSWORD` (the database password).
   - **Variables** tab → New repository variable: `SUPABASE_PROJECT_REF` (the 20 letters in `https://<ref>.supabase.co`),
     `APP_SITE_URL` (the website address, no slash at the end).
3. **Actions → Deploy to Supabase → Run workflow**, branch `main`, type `DEPLOY`, Run. It applies the migrations, deploys the
   function and sets its website address. GitHub hides the secrets in the logs.
4. Optional: delete the access token in Supabase afterwards and create a new one the next time.

### 2B. From your PC instead

Install Node.js 22 LTS and Git, then, in a terminal (each line separately), inside a fresh clone of the repository:

```bash
cd machining-tracker
```
```bash
npm ci
```
```bash
npx supabase login
```
```bash
npx supabase link --project-ref <your-project-ref>
```
```bash
npx supabase db push
```
```bash
npx supabase functions deploy admin-users --use-api --no-verify-jwt
```
```bash
npx supabase secrets set APP_SITE_URL=https://cess-machining-tracker.pages.dev APP_ALLOWED_ORIGINS=https://cess-machining-tracker.pages.dev
```

`link` and `db push` ask for the database password; type it only there. `--no-verify-jwt` is intended: Supabase warns that
the platform's JWT check breaks with its new signing keys, so the function verifies every caller itself (sign-in token checked
by the database, Admin role and MFA required). Tests cover forged tokens.

Check in Supabase → **Integrations → Cron** that the jobs `cess-reminders` and `cess-weekly-report` exist. If the migration
could not enable Cron, enable **Cron** there once and run `db push` again.

## 3. Authentication settings (Supabase dashboard)

Set these by hand. Do **not** use `supabase config push`: `supabase/config.toml` holds the local test addresses.

| Where | Setting |
|---|---|
| Authentication → Sign In / Providers | **Allow new users to sign up: OFF** (accounts only by Admin invitation). **Email** provider: enabled |
| Email provider settings | **Secure password change: ON**. Minimum password length **12**; required characters **lowercase, uppercase and digits** |
| Authentication → Multi-Factor | **TOTP (authenticator app)**: enabled (mandatory in the app for Admin and Manager) |
| Authentication → URL Configuration | Site URL `https://cess-machining-tracker.pages.dev`; Redirect URLs `https://cess-machining-tracker.pages.dev/auth/confirm` |
| Authentication → Emails → Templates | **Invite user**: subject `Your CESS Machining Tracker account`, body from `supabase/templates/invite.html`. **Reset password**: subject `Reset your CESS Machining Tracker password`, body from `supabase/templates/recovery.html` |

Supabase's built-in email sender is for testing only and sends very few emails. The app does not depend on it: Admins copy the
one-time invitation or reset link and send it themselves (for example on WhatsApp). Automatic email needs custom SMTP
(`SETUP_ACCOUNTS.md`, section 5).

## 4. Publish the website (Cloudflare Pages)

1. Sign up at dash.cloudflare.com (Free).
2. **Workers & Pages → Create → Pages → Import an existing Git repository**.
   - Connect GitHub. When GitHub asks, allow the Cloudflare app on **this repository only**.
   - Select the repository.
3. Settings:

   | Field | Value |
   |---|---|
   | Project name | `cess-machining-tracker` |
   | Production branch | `main` |
   | Framework preset | None |
   | Build command | `npm ci && npm run build` |
   | Build output directory | `apps/web/dist` |
   | Root directory (advanced) | `machining-tracker` |

4. **Environment variables** (Production):

   | Name | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `SKIP_DEPENDENCY_INSTALL` | `1` (the build command installs exactly the locked versions) |
   | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |

   **Never** add the secret key, the database password or the access token to Cloudflare.
5. **Save and Deploy**. The build takes about 2 minutes.
6. Recommended: **Settings → Builds → Branch control → Preview branches: None**. Otherwise every other branch gets its own public
   preview address connected to the live database.

The build writes `_headers` with the security rules: Content-Security-Policy limited to your Supabase project, no framing,
HSTS, nosniff, no caching of the app page. Unknown paths such as `/jobs/…` are served by Cloudflare's single-page-app mode.
The `.pages.dev` domain is HTTPS-only in browsers. A custom domain is optional and is the only item that costs money
(about ₹800–1,200 a year for the domain).

## 5. Create the first Admin (once)

1. Supabase → **Authentication → Users → Add user → Create new user**:
   - Your company email and a strong password.
   - Tick **Auto Confirm User**.
2. Supabase → **SQL Editor** → run (with your email):
   ```sql
   select private.bootstrap_first_admin('your.name@cess.co.in');
   ```
   It works only while there is no active Admin, and it cannot be reached through the website or the API.
3. Open the website, sign in, and set up your authenticator app when asked (mandatory for Admin).
4. Invite the team: **Users → Invite user → Copy link**, and send each person their link. A link works once.

## 6. Optional: CAPTCHA on sign-in (Cloudflare Turnstile, free)

Order matters: the website must have the site key **before** Supabase starts requiring the CAPTCHA.
1. Cloudflare → **Turnstile → Add widget**:
   - Name: `CESS tracker`.
   - Hostname: `cess-machining-tracker.pages.dev`.
   - Mode: Managed.
   - Copy the **Site key** and the **Secret key**.
2. Cloudflare Pages → the project → **Settings → Variables**: add `VITE_TURNSTILE_SITE_KEY` = the site key. Then **Deployments →
   Retry deployment**. The new build allows Cloudflare's challenge in the Content-Security-Policy and shows the check on the
   sign-in and forgot-password pages.
3. Supabase → **Authentication → Attack Protection → Enable CAPTCHA protection** → provider **Turnstile** → paste the
   **Secret key**.

## 7. Verify (I do this once you send the three values)

```bash
node tools/deploy-check/verify.mjs --site https://cess-machining-tracker.pages.dev --supabase https://<ref>.supabase.co --key sb_publishable_... --report docs/DEPLOYMENT_CHECK.md
```

It uses only public information and checks the following:

**Website**
- HTTPS.
- Security headers on the home page and on direct links.
- Single-page routing.
- `_headers` and `.env` are not served.
- No secret key, `service_role` key or database password in any JavaScript file.
- The site is built for this Supabase project.

**Supabase**
- Sign-up is off and email sign-in is on.
- None of the 41 tables and views can be read without signing in.
- Business functions and the Admin bootstrap refuse anonymous calls.
- The attachment bucket is private.
- The user-admin function refuses other websites and visitors who are not signed in, and accepts this website.

Then I sign in through the public address and run the main journeys. Only then is Phase 9 complete.

## 8. After deployment

- **Backups**: set up the PC backup tool against the live project (`docs/BACKUP_AND_RECOVERY.md`). The tool runs on your PC
  and the backups are stored in `C:\Users\<you>\CESS-Machining-Data`, outside OneDrive. It needs connection details that stay
  only on that PC.
- **Updates**: merging into `main` rebuilds the website automatically. Database changes are applied with step 2 again;
  migrations already applied are skipped.
- **Checks on every pull request**: GitHub Actions runs type checks, unit tests, the production build, and the database,
  browser and production-build tests on a throw-away local Supabase (`.github/workflows/ci.yml`). It uses no secret.
