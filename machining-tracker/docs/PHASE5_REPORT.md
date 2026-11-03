# Phase 5 report: commitment history, vendor reliability score, vendor cost comparison

Status: **complete and tested locally** (not deployed). Exact rules: `docs/RELIABILITY_RULES.md`.

## What you can do now
| Screen | What it does |
|---|---|
| **Job page > Revise commitment** | Enter the new committed date, who asked for it (vendor or CESS) and the reason. The original date never changes; each revision is numbered and permanent |
| **Job page > Commitment timeline** | Per vendor: date given, original commitment, every revision (previous → new, days moved, days from original, requested by, reason, who recorded it), and the outcome with lateness against the **original** and the **latest** date |
| **Jobs Register** | "Revised N×" badge (red "frequent" at the revisions cap); revision count in the Excel export; delay vs original and vs latest on the job page |
| **Vendor Reliability** | Ranking for a financial year (or all years) and category; one score per vendor or per vendor and category; jobs used, on-time %, average delay when late, revisions (vendor / CESS), "Frequently revises", vendor-caused vs other cancellations, overdue now; "Insufficient data (n of 5 jobs)" instead of a misleading score; **How calculated** panel with every factor, the renormalised weights and every job (with the factors it was used in, or why it was left out); Excel export |
| **Vendor page** | Reliability card (overall and per category, by FY), the measures above, cancellations by reason, and the vendor's commitment revisions |
| **Cost Comparison** | New comparison (part, category, quantity, required-by); add each vendor's quotation as a per-part rate or a total (the other is calculated); lowest / highest / average, price difference in ₹ and %, each quote vs lowest and vs average; two charts (total cost, delivery days); recommendation with its weights and anything left out; choose a vendor (reason required if not the recommended one); **Create job** after confirming date given, committed date, Given By and staff user; price and job history for the part and the vendors' recent jobs in the category; Excel export |
| **Price History** | Job amounts and quotations for any part text or category, per vendor (lowest / average / highest / latest per part) |
| **Settings > Cost comparison** | Recommendation weights (price / reliability / delivery, default 45 / 35 / 20; never price-only), minimum quotations, quotation-age warning |

Screenshots: `docs/screenshots/18-*.png` to `28-*.png`.

## Rules enforced by the database
- Original committed date: set once, never changed. Current date changes only through a revision; revisions are append-only
  (UPDATE / DELETE / TRUNCATE refused, even for the database owner) and recorded in the job's Activity History.
- Reliability: one group per job (returned / vendor-caused cancellation / excluded), on-time and delay against the original date,
  vendor-caused cancellations counted once, in their own factor; no score below the minimum sample or with fewer than 3 factors.
- Cost comparison: one live quotation per vendor per comparison; nothing deleted (withdraw with a reason); quotes locked once a vendor
  is chosen (reopen with a reason); a different choice from the recommendation needs a reason; jobs are created only by the explicit
  "Create job" confirmation, through the normal job checks and permissions.
- All new functions check permissions on the server: Staff get "permission denied" even when calling the API directly.

## Tests (run 2026-11-03)
| Suite | Result |
|---|---|
| Unit (adds commitment outcome against original / latest date, financial-year list, score labels, cost-comparison settings) | 61 / 61 |
| Integration (real local Supabase; 20 Phase 5 tests: **Example 2** revision history, **Example 7** reliability with exact factor values and sample sizes, **Example 6** comparison figures and recommendation, settings, permissions, append-only history) | RESULT_INTEGRATION |
| Browser (Playwright): revise commitment and timeline, reliability ranking and "how calculated" with Excel export, three quotations with figures, charts, manual choice with reason, confirmed job creation, phone layout of all Phase 5 screens | RESULT_E2E |
| Type check, production build | clean |

Also fixed while testing on a phone: cards inside grids could not shrink below their table width, and a hidden table header label
could stretch the page sideways; both fixed in the shared components, so every page benefits.

## Decisions I made that you may want to change
1. **Who asked for a revision.** Each revision records whether the vendor or CESS asked for it. Only vendor-requested revisions lower
   "commitment stability". If you prefer, every revision can count (one-line change).
2. **On-time stays against the original date even when CESS asked for the change.** This follows your rule literally. If a postponement
   requested by CESS should move the on-time reference for that job, tell me and I will add it.
3. **Quality (25%) is left out until Phase 6** records inspections; the other five weights are scaled up to 100% and the screen says so.
4. **Completion time** needs a "usual time" for the category: at least 3 returned jobs from at least 2 vendors; otherwise it is left out.
5. **Recommendation weights 45 / 35 / 20** (price / reliability / delivery). Quality counts through the reliability score to avoid
   counting it twice. A factor is used only if every quoted vendor has it.

## What to expect with real data
- Returned jobs come from Phase 6 (material returns). Until then, only imported Excel history has returns. The Excel tracker has no
  committed dates, so imported jobs can feed only completion time and cancellations: vendors with only imported history will show
  "Not enough factors" rather than a score. That is intended (no misleading scores); scores appear as new jobs are returned.

## Not in this phase
- Material returns, partial returns, quality inspection (the quality factor), completing new jobs, payments: **Phase 6**.
- WhatsApp click-to-chat (including "revised delivery date confirmation"), reminders: **Phase 7**. Dashboard and weekly reports: **Phase 8**.
- Recharts 3.10.1 was added for the charts (loaded only on the comparison page). No new npm-audit findings; the two known ExcelJS
  findings from Phase 4 are unchanged.
