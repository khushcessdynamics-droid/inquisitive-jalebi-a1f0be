# Dashboard and weekly management report: what every number means

All figures are calculated from the recorded data when the screen opens (dashboard) or when the report is made (weekly report).
A figure that cannot be calculated is shown as **"—"**, never as 0 (e.g. acceptance % with no inspections, average delay when nothing
was late). Dates are Indian dates.

## 1. Dashboard (Home; users with "View reports")
Each user sees only the jobs they may see; money figures only with "View payments"; reliability only with "View vendor reliability".
Period figures use the chosen **financial year** (default: current); "now" figures are as of today. **Every number, bar and table row
opens the matching records.**

| KPI | Definition | Opens |
|---|---|---|
| Active jobs | given to a vendor and not completed or cancelled (incl. partially returned and awaiting inspection) | Jobs Register, Open |
| New jobs this month | jobs whose **start date** (date given to the first vendor; for drafts the day entered) is in this month | Register, started in the month |
| Pending jobs | not completed and not cancelled, **including drafts** | Register, those statuses |
| Overdue / Due today | job status now | Register |
| Completed (FY) | jobs completed (closed) in the financial year; also this month | Register, completed in the FY |
| Vendor spending (FY) | payments made in the FY by payment date, reversals subtracted; also this month | Payments, monthly |
| Outstanding payments | sum of positive balances of all job accounts now | Payments, pending |
| Average vendor reliability | average score of vendors **with** a score in the FY ("—" when none has enough jobs) | Vendor Reliability |
| Quality acceptance | accepted ÷ inspected pieces of inspections dated in the FY | Quality |

Charts: monthly job trend (started vs completed), monthly vendor spending, vendor-wise job distribution (vendor assignments given in
the FY), category-wise work (jobs started in the FY), completed vs pending vs cancelled (jobs started in the FY), on-time vs late
(vendor assignments completed in the FY, against the **original** date; those without a date are listed, not judged), vendor
reliability ranking, quality rejection trend (rejected + rework as % of inspected pieces per month; months without inspections empty).

Tables: overdue jobs, deliveries due in the next 7 days, recently added, recently completed, returns waiting for inspection,
pending payments, vendors requiring follow-up (vendors with overdue jobs, and vendors whose score is "Needs Improvement").

Staff without "View reports" see their own jobs: open, overdue, due today, drafts, and the jobs needing attention.

## 2. Weekly management report (Weekly Reports page)
- **Automatic**: the server (pg_cron, every 15 minutes) makes it on the configured weekday at or after the configured time (default
  **Monday 08:00 IST**) for the **7 days before that day** (Monday → previous Monday to Sunday). Once per week. Settings > Weekly report.
- **On request**: "Make report" for any week that has ended. Earlier versions stay in the history; nothing is overwritten or deleted.
- Downloads: **PDF** (amounts printed as "Rs." because standard PDF fonts have no ₹ sign) and **Excel** (summary sheet + one sheet per list).
- Email / WhatsApp delivery stays off until a provider is configured and you switch it on.
- The financial section is visible only to users who may view payments.

| Section | Contents (W = the report week) |
|---|---|
| A. Job summary | new jobs (start date in W), completed (closed in W), cancelled (every vendor cancelled, last cancellation in W); pending, overdue and partially returned **now** |
| B. Delivery performance | jobs due in W (latest committed date in W, cancelled excluded), completed on time / late against the original date, completed without a date (not judged), average delay of the late ones, vendors whose commitments were revised in W |
| C. Vendor performance | best and lowest 3 reliability scores (FY of the week), best vendor per category, vendors with most overdue jobs now |
| D. Financial summary | job value of vendor assignments given in W (jobs without an amount counted separately), payments made in W, outstanding now, spending per vendor in W, pending payments |
| E. Quality summary | quantity sent in W (jobs without a quantity counted separately), returned in W, accepted / rejected / rework of inspections in W, acceptance % |
| F. Follow-ups | jobs due next week, overdue jobs, returns waiting for inspection, pending payments |

**Comparison with the previous week**: period figures are recalculated for the previous week; "now" figures come from the previous
week's stored report when one exists (otherwise "—").

## 3. Quality page
Every inspection (date, job, part, vendor, return, accepted / rejected / rework, status, inspector, remarks) with filters by financial
year, vendor and category and **Export to Excel**; plus the returns waiting for inspection.

## 4. Jobs Register additions
Filters opened from the dashboard (status, start-date range, completion range) are shown as a removable "Filtered from the dashboard"
line. New columns: quantity sent / returned, and for users who may view payments the balance under the amount (also in the Excel export).
