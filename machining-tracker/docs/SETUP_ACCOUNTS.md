# Accounts and setup steps (nothing has been created yet)

Deployment steps: **`docs/DEPLOYMENT.md`**.

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
| The website address | `https://<project-name>.pages.dev` (known when you name the Cloudflare project) | Supabase Auth URL settings + Edge Function secret `APP_SITE_URL` | No |
| Supabase access token (`sbp_…`) | Supabase → Account → Access Tokens (only for the GitHub deploy workflow) | GitHub repository secret `SUPABASE_ACCESS_TOKEN` | **Yes** |

## 3. Supabase project setup
## 4. Cloudflare hosting

Both are now a step-by-step guide in **`docs/DEPLOYMENT.md`**: project creation (Mumbai region), loading the database and the
user-admin function (from GitHub Actions or from your PC), authentication settings, Cloudflare Pages settings, the first Admin,
optional Turnstile CAPTCHA and the verification run. Do not use `supabase config push`: `supabase/config.toml` holds the local
test addresses and would overwrite the live Site URL and redirect URLs.

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
