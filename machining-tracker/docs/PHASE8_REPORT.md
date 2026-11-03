# Phase 8 report: dashboard, weekly management report, quality records

Status: **complete and tested locally** (not deployed). Definitions of every figure: `docs/DASHBOARD_AND_REPORTS.md`.

## What you can do now
| Screen | What it does |
|---|---|
| **Dashboard** (Home) | 10 KPIs (active, new this month, pending, overdue, due today, completed, vendor spending, outstanding, average reliability, quality acceptance), 8 charts (monthly job trend, monthly spending, vendor-wise jobs, category-wise work, completed vs pending, on-time vs late, reliability ranking, rejection trend) and 7 tables (overdue, upcoming deliveries, recently added, recently completed, pending inspections, pending payments, vendors requiring follow-up). Financial year selector. **Every number and chart opens the matching records** |
| **Home for Staff** | Their own open, overdue, due-today and draft jobs and the jobs needing attention |
| **Weekly Reports** | Automatic report every Monday 08:00 IST for the previous Monday to Sunday (configurable), "Make report" for any finished week, history, sections A to F with this week / previous week / change, **PDF** and **Excel** downloads |
| **Quality** | All inspection records with filters and Excel export; returns waiting for inspection |
| **Jobs Register** | Dashboard filters (status, started in, completed in) with a clear button; quantity sent / returned; balance under the amount for users who see payments; both in the Excel export |
| **Settings > Weekly report** | On/off, weekday and time; email/WhatsApp delivery shown as not configured |

Screenshots: `docs/screenshots/46-*.png` to `52-*.png`.

## Rules
- Only recorded data: a figure that cannot be calculated is "—", not 0; jobs without a quantity or amount are counted and named
  separately instead of being treated as 0.
- The dashboard runs with the **user's own access** (database row security), so Staff given "View reports" still see only their jobs;
  money needs "View payments".
- Reports are stored permanently (no edit, no delete), made automatically by the database scheduler or on request.

## Tests (run 2026-11-03)
| Suite | Result |
|---|---|
| Unit | RESULT_UNIT |
| Integration (real local Supabase; 5 Phase 8 tests: KPIs, money, quality, on-time, tables and follow-ups on known data; access-limited dashboard; weekly report A-F with hand-checked figures for a fixed past week; scheduled run on the right weekday and time only, once; previous-week comparison; permissions; permanent history) | RESULT_INTEGRATION |
| Browser (Playwright): KPIs and click-through to filtered registers, vendor bar click; make the weekly report, sections and figures, PDF and Excel downloads; quality records export; Staff home; phone layout | RESULT_E2E |
| Type check, production build | clean |

## Decisions I made that you may want to change
1. **"Pending jobs" includes drafts**; "Active jobs" are the ones with a vendor.
2. **"New jobs"** count by the date the job was given to the first vendor (drafts by the day entered), so imported history lands in
   the right month.
3. **Report week** = the 7 days before the report day (Monday report → previous Monday to Sunday).
4. **PDF amounts use "Rs."** (built-in PDF fonts have no ₹); Excel and the screen use ₹. A ₹ font can be embedded later (larger file).

## Not in this phase
- Deployment (Supabase + Cloudflare, your accounts): **Phase 9**. Final end-to-end acceptance testing: **Phase 10**.
