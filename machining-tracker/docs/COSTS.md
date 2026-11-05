# Estimated monthly running cost

**Today: ₹0 per month.** Everything runs on free plans with no payment card on file, so nothing can be charged. Prices and limits
were read on the providers' pages on 2026-11-03 (`FREE_TIER_VERIFICATION.md`); check again before deciding on an upgrade.

## What it costs

| Item | Plan | Monthly cost | Notes |
|---|---|---|---|
| Supabase (database, sign-in, files, Edge Function, scheduler) | Free | **₹0** | Without a card on file Supabase cannot charge; over a limit the service stops that item instead of billing |
| Cloudflare Pages (website, HTTPS, security headers) | Free | **₹0** | 500 builds a month; static files are not metered |
| Cloudflare Turnstile (optional CAPTCHA) | Free | **₹0** | |
| GitHub (code, tests, deployment, daily live check) | Free | **₹0** | Free for public repositories. A private repository gets US$12 of included Actions usage a month (about 2,000 Linux minutes); one full test run takes about 15 minutes and the daily check about 1 minute. Without a payment method GitHub stops runs instead of charging |
| Domain | — | **₹0** | `*.pages.dev`, or a subdomain of your existing `cess.co.in` (`DOMAIN_AND_HTTPS.md`). A new domain would be about ₹800–1,200 a year |
| Backups | Your PC | **₹0** | Backup tool on an office PC; a USB drive for the second copy |
| WhatsApp | Click-to-chat | **₹0** | The optional WhatsApp Business API (automatic sending) is charged by Meta per message; not used |
| Email | Copy-link invitations | **₹0** | Optional SMTP providers have free tiers |

## How long the free plan lasts: measured

Measured on 2026-11-03 with `npm run test:capacity`: **5,000 complete jobs** were created through the normal API (vendor and amount,
a commitment revision on one in three, return and inspection, invoice and payment, WhatsApp opened on half), then the space was
measured. The measurement records were deleted afterwards.

| Measure | Result |
|---|---|
| Database space per complete job (including its share of the activity history) | **about 11 KB** (activity history ≈ 8 KB, about 9 entries per job) |
| Space used by 5,000 jobs | 54 MB (empty database: 17 MB) |
| Jobs that fit in the free 500 MB | **about 45,000** |

| Jobs per month | Database growth per year | Free database full after |
|---|---|---|
| 100 | about 13 MB | more than 30 years |
| 300 | about 39 MB | about 12 years |
| 1,000 | about 130 MB | about 3½ years |

**File storage is the limit that comes first.** The free plan holds 1 GB of attachments (drawings, photos, PDFs). That is about
1,000 drawings of 1 MB, or 2,000 of 500 KB. At 100 jobs a month with one 1 MB drawing each, it fills in **under a year**. System
Health shows the file storage used and warns at 80 %. Ways to stretch it: save drawings as PDF rather than photos, scan at 150–200 dpi,
attach only the drawings that are needed.

Speed with 5,000 jobs, measured on the development machine (the free Supabase server has a shared CPU and 0.5 GB memory, so expect
it to be slower):

| Screen | Time |
|---|---|
| Jobs Register, first page with the total count | 0.07 s |
| Search by part | 0.05 s |
| Excel export of all 5,000 jobs (data) | 0.15 s |
| Dashboard (all figures, charts and tables) | 0.7 s |
| Weekly report (made automatically in the background) | 1.3 s |
| Vendor reliability / payments by vendor / activity history | under 0.15 s each |

The register, dashboard and report were made faster after the first measurement (the quantities in the Jobs Register are now
worked out in the same database query instead of one extra lookup per job): register first page 0.24 s → 0.07 s, dashboard
0.9–1.3 s → 0.7 s, with identical figures.

## When the free plan is no longer enough

| Trigger | Option | Cost |
|---|---|---|
| File storage near 1 GB, or the database near 500 MB | **Supabase Pro** | **US$25 a month** (about ₹2,200 at ₹88 per US$; check the current rate). Includes 100 GB file storage, 8 GB database disk, 250 GB egress, daily backups kept 7 days, no pausing. The spend cap is on by default, so usage beyond the included amounts is blocked rather than billed |
| The project should never pause after a quiet week, or Supabase's own daily backups are wanted | Supabase Pro | as above |
| Point-in-time recovery (restore to any minute) | Pro + add-on | US$100 a month extra; the free backup tool already gives a daily verified backup, so this is not needed for this size |

Payments to Supabase are in US dollars by card. For an Indian business, GST on imported services (reverse charge) may apply; ask
your accountant. Upgrading needs your approval and a payment card; nothing in this application upgrades by itself.

To re-measure on a developer PC: `CAPACITY_JOBS=5000 npm run test:capacity` (writes `capacity-result.json`; local database only).
