# Accounts and setup steps (nothing has been created yet)

No account has been created and no service connected. Follow these steps when you are ready, or let me guide you live.
Dashboard menu names can change slightly over time; the setting names are given so you can search for them.

## 1. Accounts you need (all free)

| Account | Used for | Cost | Payment card needed? |
|---|---|---|---|
| **GitHub** (you already have it) | Source code | ₹0 | No |
| **Supabase** (supabase.com) | Database, logins, file storage, Edge Function | ₹0 on the Free plan | **No. Do not add one**, so nothing can ever be charged |
| **Cloudflare** (cloudflare.com) | Hosting the website over HTTPS, optional CAPTCHA | ₹0 | No |
| Email provider (optional, later) | Sending invitation/reset emails automatically | Free tiers exist | Only if you choose one |

Notes:
- The Supabase Free plan allows **2 active projects** across all organisations you own or administer. Your inventory app (`index.html`) also uses Supabase; if that account already has 2 active projects, use a different account or pause one.
- Choose the **Mumbai (ap-south-1)** region if offered, otherwise Singapore.

## 2. Information I will need from you (and what never to share)

| Item | Where you find it | Where it goes | Secret? |
|---|---|---|---|
| Project URL `https://<ref>.supabase.co` | Supabase → Project Settings → API | Cloudflare build variable `VITE_SUPABASE_URL` | No |
| Publishable (anon) key | Supabase → Project Settings → API keys | Cloudflare build variable `VITE_SUPABASE_PUBLISHABLE_KEY` | No (public by design; RLS protects data) |
| Project ref | Part of the URL | `supabase link --project-ref` | No |
| Database password | Chosen when creating the project | Only typed into your own terminal for `supabase db push` | **Yes: never send it to anyone, never put it in Git or chat** |
| Secret / service_role key | Supabase → API keys | Only the local backup tool on your PC (Phase 3B). Edge Functions get it automatically | **Yes: never in the website, Git or chat** |
| The website address | Cloudflare, after the first deployment | Supabase Auth URL settings + Edge Function secret `APP_SITE_URL` | No |

## 3. Supabase project setup

1. Create the project (Free plan, Mumbai region). Save the database password in a password manager.
2. On your PC (with Node.js 22 installed), in the `machining-tracker` folder:
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
   `db push` applies the SQL migrations in `supabase/migrations` (it asks for the database password).
3. Deploy the Edge Function and set its non-secret configuration:
   ```bash
   npx supabase functions deploy admin-users
   ```
   ```bash
   npx supabase secrets set APP_SITE_URL=https://<your-site> APP_ALLOWED_ORIGINS=https://<your-site>
   ```
4. **Authentication settings** in the dashboard. These match `supabase/config.toml`, which only applies to the local test stack:
   - Sign-ups: **Allow new users to sign up = OFF** (accounts only by Admin invitation). Keep the **Email provider enabled** (needed for password sign-in).
   - Password: minimum length **12**, required characters **lower, upper case and digits**. Turn on **Secure password change**.
   - Multi-factor: **TOTP (authenticator app) enabled**.
   - URL configuration: Site URL = `https://<your-site>`; Redirect URLs = `https://<your-site>/auth/confirm`.
   - Email templates: in **Invite user** and **Reset password**, use the link from `supabase/templates/invite.html` and `recovery.html`:
     `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` (or `type=recovery`).
   - Optional, recommended: **CAPTCHA protection** with Cloudflare Turnstile (free). The login-page integration is added during deployment.
   - The CLI command `npx supabase config push` can copy these settings from `config.toml`. Check the result in the dashboard either way.
5. **Create the first Admin** (once):
   1. Authentication → Users → **Add user** → **Create new user**: your company email and a strong password, with **Auto Confirm User** ticked.
   2. SQL Editor → run:
      ```sql
      select private.bootstrap_first_admin('your.name@cess.co.in');
      ```
      It works only while no active Admin exists and is not reachable through the website or API.
   3. Open the website, sign in, and set up your authenticator app when asked (mandatory for Admin).
6. Invite the team from **Users → Invite user** → **Copy link**, then send each person their link (for example on WhatsApp). The link works once.

## 4. Cloudflare hosting (static site, no server code)

Cloudflare now recommends **Workers (static assets)** for new sites; **Pages** still works. Both are free for static files and both read the generated `_headers` / `_redirects` files. Pick one when we deploy (Phase 9). Settings either way:
- Repository: this GitHub repo; root directory `machining-tracker`
- Build command: `npm ci && npm run build -w apps/web`
- Output directory: `apps/web/dist`
- Environment variables: `NODE_VERSION=22`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- **Never** add the secret/service key or database password to Cloudflare.

The free `*.pages.dev` / `*.workers.dev` address includes HTTPS. A custom domain is optional and is the only item in this plan that costs money (domain registration, about ₹800–1,200 per year).

## 5. Optional email (later, free options)

The app is provider-independent: invitations and resets work by copied link today. To send emails automatically, add custom SMTP in Supabase → Authentication → SMTP settings. Free tiers (check current limits first): Brevo, Resend, or Gmail/Google Workspace SMTP with an app password. No code change is needed.

## 6. Optional: automatic WhatsApp (WhatsApp Business Cloud API) — not needed for click-to-chat

Click-to-chat works today with no account. Automatic sending is a separate, optional step and is **not built until you ask for it**:
1. A Meta Business account (business.facebook.com) and a WhatsApp Business Platform app (developers.facebook.com).
2. A phone number for the business that is **not** used in the normal WhatsApp app, verified with Meta.
3. Message templates approved by Meta (the ten app templates would be submitted for approval; reminders outside a 24-hour chat window
   must use approved templates).
4. Each vendor's consent (opt-in) to receive WhatsApp messages from CESS.
5. Information needed from you: the phone number ID, the WhatsApp Business account ID and a **permanent access token**, entered only as
   Supabase Edge Function secrets (never in the website or in Git), plus a webhook verify token you choose.
6. Cost: Meta charges per conversation/message category by country; check Meta's current WhatsApp pricing for India before approving.
   Nothing is activated without your approval.

## 7. Reminder scheduler (included in the migrations)
The migrations enable `pg_cron` ("Supabase Cron") and create the job `cess-reminders`. After deploying, check in Supabase →
Integrations → Cron that the job exists and runs. If the extension cannot be created by the migration on your project, enable
"Cron" under Integrations once and run the migrations again.
