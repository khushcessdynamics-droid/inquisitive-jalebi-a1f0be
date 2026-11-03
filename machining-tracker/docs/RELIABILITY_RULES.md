# Vendor reliability score, commitment history and cost comparison: the exact rules

Everything below is calculated by the database every time a screen is opened (nothing is stored or cached), from the jobs that
are recorded. Weights and limits come from **Settings > Reliability score** and **Settings > Cost comparison**.
Business dates are Indian dates (Asia/Kolkata).

## 1. Commitment revision history
- The first committed date a vendor gives becomes the **original commitment**. The database refuses any later change to it.
- Every change of the committed date is a **revision**: revision number, original date, previous date, new date, date of change,
  who asked for it (**the vendor** or **CESS**), reason, and the user who recorded it. Revisions can never be edited or deleted,
  not even by the database owner (append-only table with triggers).
- Only the current vendor of an open job can have its date revised. The new date cannot be before the date given to the vendor.
- The job page shows a **commitment timeline** for every vendor of the job: given, original commitment, each revision, and the
  outcome (returned / cancelled / today) with lateness against the **original** and the **latest** date.
- A job revised as many times as the "revisions cap" (default 2) is highlighted as **frequently revised** in the Jobs Register
  and on the job page. A vendor is marked **"Frequently revises"** when at least half of its (3 or more) committed jobs were revised,
  or any one job reached the cap.

## 2. Which jobs count (one group each, no double counting)
| Group | Used for |
|---|---|
| **Returned** (vendor assignment completed) | On-time, delay, stability, completion time, cancellation (as a non-cancelled job) |
| **Cancelled: vendor-caused** (reason marked vendor-caused in Settings) | Only the cancellation factor |
| Cancelled: not vendor-caused (customer cancelled, planning change, ...) | Excluded, shown separately |
| Cancelled: imported without a reason | Excluded until classified in Missing Data Review |
| Still with the vendor | Excluded from the score; shown as "overdue now" |
| Job closed without a recorded return | Excluded |
| Archived jobs | Never counted |

**Eligible jobs** = returned + vendor-caused cancellations. Filters (financial year, dates) use the date the job was given to the vendor.

## 3. The six factors (approved Option 1 weights, editable)
| Factor | Weight | Score 0 to 100 | Jobs used |
|---|---|---|---|
| On-time delivery | 30 | returned on or before the **original** committed date ÷ returned jobs with a committed date | returned with a committed date |
| Quality performance | 25 | accepted ÷ inspected pieces, over every inspection on returned jobs (rework and rejected pieces count as not accepted; a reworked piece inspected again counts again) | returned jobs with at least one inspection. Jobs cancelled for a quality reason count only in the cancellation factor |
| Delay performance | 15 | 100 × (1 − average days late ÷ delay cap 14), averaged over late jobs only; 100 if none was late | returned with a committed date |
| Commitment stability | 10 | 100 × (1 − vendor-requested revisions per job ÷ revisions cap 2). Revisions requested by CESS are not counted | returned with a committed date |
| Completion time | 10 | 100 × min(1, Σ category usual days ÷ Σ days taken). Usual days = median days of returned jobs in the same category across all vendors (needs 3 jobs from 2 vendors) | returned jobs whose category has a usual time |
| Vendor-caused cancellation | 10 | 100 × (1 − vendor-caused cancellations ÷ eligible jobs) | eligible jobs |

**Score** = Σ(weight × factor score) ÷ Σ(weights of the factors that have data). A factor without data is left out and the other weights
are scaled up to 100%, shown as "Weight used" on the "How this score was calculated" panel.

**No score** is shown when there are fewer than 5 eligible jobs ("Insufficient data (n of 5 jobs)") or fewer than 3 factors with data.
Labels: 85+ Excellent, 70+ Good, 50+ Average, below 50 Needs Improvement (editable).

Shown beside the score, not scored again: on-time %, average delay when late (vs original and vs latest date), total delay days,
overdue-now count and %, revisions (all / by vendor), average completion time, quality acceptance % and rework/rejection %
(with piece counts), cancellations by reason.

A job counts as **returned** when its vendor assignment is completed: automatically when every piece is back and inspected, or
when an authorised user closes it with a reason (`docs/RETURNS_AND_PAYMENTS.md`). The return date used for on-time and delay is the
date of the **last** return.

### Worked example (from the automated tests)
A vendor with 6 returned jobs (4 on time, 2 late by 4 and 6 days), 1 vendor-caused cancellation, 1 customer cancellation (excluded),
3 vendor-requested revisions and 1 CESS-requested revision, in a category whose usual time is 4 days (vendor took 33 days for 6 jobs):

| Factor | Score | Weight used |
|---|---|---|
| On-time 4/6 | 66.7 | 40.0% |
| Quality | no data | not used |
| Delay: average 5 days late, cap 14 | 64.3 | 20.0% |
| Stability: 3 ÷ 6 ÷ 2 = 0.25 | 75.0 | 13.3% |
| Completion: 24 ÷ 33 | 72.7 | 13.3% |
| Cancellation: 1 of 7 | 85.7 | 13.3% |
| **Score** | **70.6 Good** (7 eligible jobs) | 75% → 100% |

## 4. Cost comparison (quotations)
- One **comparison** = one requirement: Part No / Part Name (single field), machining category, required quantity, optional required-by date.
- Each vendor gives one live quotation: quotation date, a **per-part rate** or **one amount for the whole quantity** (the other figure
  is calculated), expected delivery days, reference, remarks. A changed offer is edited (old figures stay in Activity History) or
  withdrawn with a reason and re-entered.
- Calculated: lowest, highest and average quotation (total and per part), price difference (highest − lowest) in ₹ and %, each
  quotation's difference from the lowest (₹, %) and from the average (%).
  Example 6: ₹10,000 / ₹12,000 / ₹15,500 → lowest ₹10,000, highest ₹15,500, average ₹12,500, difference ₹5,500 = 55.0%.
- **Recommendation (advice only)**, from 2 quotations upwards: value score = weighted price score (lowest ÷ this total), reliability
  score (the vendor's score in this category, or overall), and delivery score (fastest ÷ these days). Default weights 45 / 35 / 20.
  Quality performance is part of the reliability score. Price can never carry 100%. A factor is used only when **every** quoted
  vendor has it (e.g. a new vendor without a score means reliability is left out for everyone, and the screen says so).
- **The person chooses.** Choosing a vendor other than the recommended one needs a reason. Choosing creates nothing; "Create job"
  opens a confirmation with date given, committed date (suggested from the delivery days), Given By and Assigned Staff User, and
  only then creates the job with the quoted total as job amount. Nothing is ever assigned automatically.
- **Price history**: job amounts and quotations for matching parts or a category, per vendor (lowest / average / highest / latest
  per-part rate where the quantity is known). Job amounts are the amounts recorded on the job (the vendor invoice amount once recorded); payments are on the Payments page.

## 5. Permissions (checked by the database)
| Action | Admin | Manager | Staff |
|---|---|---|---|
| Revise commitment dates | ✔ | ✔ | — |
| View reliability scores and the jobs behind them | ✔ | ✔ | — |
| View cost comparisons and price history | ✔ | ✔ | — |
| Add/edit quotations, choose vendor, create job from a comparison (also needs "Create jobs") | ✔ | ✔ | — |
| Change reliability and cost-comparison weights (Settings) | ✔ | — (can be granted) | — |
Staff can be given any of these as a personal exception in Roles & Permissions.
