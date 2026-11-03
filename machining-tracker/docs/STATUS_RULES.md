# How job status and day counts are calculated

All values are calculated by the database on every read, using **today's date in India (Asia/Kolkata)**. Nothing is
stored, so a job becomes "Overdue" automatically the day after its committed date. Thresholds come from Settings > Job thresholds.

## Status (first matching rule wins)
| Status | Rule |
|---|---|
| Completed | Every piece sent is back and inspected (accepted or rejected), or an authorised user closed the job with a reason. Imported historical jobs are completed with a note |
| Draft | Saved but not yet given to any vendor |
| Cancelled | Every vendor assignment was cancelled and the job was not forwarded |
| *Once anything is returned:* | |
| Overdue / Due Today | Pieces are still with the vendor (or the quantity is unknown) and the committed date has passed / is today |
| Quality Inspection Pending | Returned pieces are waiting for inspection |
| Partially Returned | Some pieces are back and inspected, the rest are still with the vendor (including pieces sent back for rework), or the quantity is unknown |
| *Nothing returned yet:* | |
| Commitment Date Missing | With a vendor, but no committed delivery date recorded (no reminders, excluded from on-time scoring) |
| Overdue | Current committed date is before today |
| Due Today | Current committed date is today |
| Due Soon | Current committed date is within "Due soon" days (default 3) |
| Sent to Vendor | Given to the vendor today (or tomorrow) |
| In Progress | With the vendor, not yet due |

A return date alone never completes a job: completion needs the quantities and inspections (rules: `docs/RETURNS_AND_PAYMENTS.md`).

## Numbers
| Field | Calculation |
|---|---|
| Returned / with vendor / awaiting inspection | from the return and inspection records of the current vendor (Register and job page) |
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
