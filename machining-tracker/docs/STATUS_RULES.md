# How job status and day counts are calculated

All values are calculated by the database on every read, using **today's date in India (Asia/Kolkata)**. Nothing is
stored, so a job becomes "Overdue" automatically the day after its committed date. Thresholds come from Settings > Job thresholds.

## Status (first matching rule wins)
| Status | Rule |
|---|---|
| Completed | The job was closed with a recorded reason (from Phase 6: after material return and inspection; today only imported historical jobs) |
| Draft | Saved but not yet given to any vendor |
| Cancelled | Every vendor assignment was cancelled and the job was not forwarded |
| Commitment Date Missing | With a vendor, but no committed delivery date recorded (no reminders, excluded from on-time scoring) |
| Overdue | Current committed date is before today |
| Due Today | Current committed date is today |
| Due Soon | Current committed date is within "Due soon" days (default 3) |
| Sent to Vendor | Given to the vendor today (or tomorrow) |
| In Progress | With the vendor, not yet due |

Phase 6 adds **Partially Returned** and **Quality Inspection Pending** from real return and inspection records.

## Numbers
| Field | Calculation |
|---|---|
| Days since given ("Days Taken" in the Excel tracker) | (return date, cancellation date, or today) minus date given to the current vendor |
| Remaining days | current committed date minus today (open jobs) |
| Delay vs original | days after the **original** commitment (today for open jobs, return date for completed); never negative |
| Delay vs latest | the same against the latest (revised) commitment |
| Revisions | number of commitment revisions of the current vendor; highlighted at the revisions cap (default 2). History and rules: `docs/RELIABILITY_RULES.md` |
| Long pending | open and with the vendor for more than "Long-pending alert" days (default 10, the Excel tracker's late limit) |
| Financial year | April to March, from the date given (e.g. 2026-27) |
| Job number | JOB-2627-0001: financial year of creation + running number per year |

## Dates kept separately
Date given to vendor · original committed date (set once, never changed) · current (revised) committed date · actual return date.
Every revision is kept permanently in the commitment history (job page > Commitment timeline).
