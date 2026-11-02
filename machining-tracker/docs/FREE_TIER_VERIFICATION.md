# Free-tier verification (checked 2026-11-02)

All values were read on the providers' official pages on 2026-11-02. Providers change limits without notice, so check again before relying on a number.
**P** = https://supabase.com/pricing, **D/** = https://supabase.com/docs/guides/

## Supabase Free plan

| Limit | Value | Source |
|---|---|---|
| Database size | 500 MB per project. Over quota: Fair Use restriction, API answers 402 | P, D/platform/database-size |
| Disk | 2 GB fixed. Database becomes **read-only at 95 %** disk | D/platform/database-size |
| Compute | Nano (shared CPU, up to 0.5 GB RAM) | P, D/platform/compute-and-disk |
| Active free projects | **2**, counted across all organisations where you are Owner/Admin | D/platform/billing-faq |
| Pausing | After **1 week of inactivity**; warning email about a week before | P, D/platform/project-pausing |
| Restore after pause | Free, one click (docs say up to 1 year; one screenshot shows 90 days) | D/platform/project-pausing |
| Automatic backups / PITR | **Not included.** Docs advise free projects to export regularly (`db dump`) and keep off-site copies | P, D/platform/backups |
| Egress | 5 GB uncached + 5 GB cached per month; no overage billing on Free | P |
| Billing | "You will not be charged while using the Free Plan" | D/platform/cost-control |
| File storage | 1 GB total; **max 50 MB per file** | P, D/storage/uploads/file-limits |
| Bucket MIME / size limits, signed URLs | Available | D/storage/buckets/creating-buckets, D/storage/serving/downloads |
| Image transformations | Pro and above | D/storage/serving/image-transformations |
| Monthly active users | 50,000 | P |
| TOTP MFA (authenticator app) | **Free**, enabled by default | D/auth/auth-mfa/totp |
| Phone MFA | Paid add-on | D/auth/auth-mfa/phone |
| Leaked-password protection | Pro and above | D/auth/password-security |
| Session time-box / inactivity timeout / single session | Pro and above | D/auth/sessions |
| JWT expiry | Configurable | D/auth/sessions |
| Auth hooks on Free | Custom Access Token, Before User Created, Send Email, Send SMS. Password-verification and MFA-verification hooks are Team/Enterprise | D/auth/auth-hooks |
| CAPTCHA (Turnstile / hCaptcha) | Available | D/auth/auth-captcha |
| Auth rate limits | Sign-in/sign-up 30 per 5 min per IP; MFA 15/min per IP | D/auth/rate-limits |
| Built-in email | **2 emails/hour, only to members of your Supabase organisation team**; not for production | D/auth/auth-smtp |
| Custom SMTP | Included on Free (starts at 30 emails/hour, adjustable) | P, D/auth/auth-smtp |
| `generateLink` | Creates invite/reset links without sending email | supabase.com/docs/reference/javascript/auth-admin-generatelink |
| Realtime | 200 concurrent connections, 2 M messages/month; DELETE events are not RLS-filtered | P, D/realtime/limits, D/realtime/postgres-changes |
| Edge Functions | 500,000 invocations/month, 100 functions, 2 s CPU, 150 s wall clock | P, D/functions/limits |
| Logs | API/DB logs 1 day; auth logs 1 hour | P |
| Usage alerts | Email when the quota is exceeded (no "approaching quota" alert found) | D/platform/billing-faq |

## Cloudflare Free

| Limit | Value | Source |
|---|---|---|
| Pages builds | 500/month, 1 at a time, 20-minute timeout | developers.cloudflare.com/pages/platform/limits |
| Pages files | 20,000 files per site, 25 MiB per file | same |
| Static asset requests and bandwidth | Free and unlimited | developers.cloudflare.com/pages/functions/pricing |
| `_headers`, `_redirects` | Supported (do not apply to Functions responses) | developers.cloudflare.com/pages/configuration/headers |
| Workers / Pages Functions | 100,000 requests/day, 10 ms CPU each; over the limit you get errors (1027/429), not a bill | developers.cloudflare.com/workers/platform/limits |
| Turnstile CAPTCHA | Free, unlimited challenges | developers.cloudflare.com/turnstile/plans |
| Platform direction | Cloudflare now recommends **Workers with static assets** for new projects; no Pages deprecation notice found | developers.cloudflare.com/pages |

## What this means for the design

| Free-tier fact | Design decision |
|---|---|
| No backups on Free | Local backup tool on your Windows PC, with verification and restore. This is required before real data is entered (Phase 3B) |
| Session timeouts are Pro-only | Idle timeout and maximum session length are enforced **inside the database** on every request (`private.session_ok`) |
| Password-verification hook is Team-only | No per-account lockout. Protection comes from the per-IP rate limit, CAPTCHA (Turnstile, free, enabled at deployment) and mandatory MFA for Admin/Manager |
| Leaked-password protection is Pro-only | 12-character minimum with mixed case and digits, enforced by Supabase Auth |
| Built-in email reaches only your team | Invitations and password resets work **without email**: the Admin copies a one-time link. Custom SMTP can be added later without code changes |
| Auth logs kept 1 hour | The app keeps its own append-only activity history |
| Pausing after 7 inactive days | Normal daily use and the daily backup keep the project active |
| Cloudflare Functions have a daily cap | The frontend is static files only (no Functions), so the cap does not apply |
| 50 MB file limit, 1 GB storage | Attachment size capped at 50 MB in settings; usage shown on System Health |

No setting in this design can create a charge, as long as no payment method is added and no paid add-on is enabled.
