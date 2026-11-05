# Phase 6 report: material returns, quality inspection, job completion, vendor payments

Status: **complete and tested locally** (not deployed). Exact rules: `docs/RETURNS_AND_PAYMENTS.md`.

## What you can do now
| Screen | What it does |
|---|---|
| **Job page > Material returns and quality inspection** | Sent / returned / with vendor / awaiting inspection / accepted / rejected / rework with acceptance and rejection %; every return (date, quantity, delivery challan) with its inspections; **Record return** (optionally inspect at once); **Inspect** each return (accepted, rejected, rework, who inspected, remarks; "all accepted" shortcut); **Void** a mistaken return or inspection with a reason |
| **Job page > Close job / Reopen job** | Close a job that will not complete by itself, with a reason; reopen a completed job (with a reason) to correct a return or inspection |
| **Jobs Register** | New tabs "Partially returned" and "Inspection pending"; "60 of 100 back · 60 to inspect" under the status; returned / accepted / rejected / with-vendor quantities in the Excel export |
| **Job page > Payments** (Admin and Manager) | Per vendor: job amount and invoice, additional charges, discount, total payable, advance, amount paid, balance, status; every entry with mode, reference and who recorded it. Admin: **Record invoice**, **Add payment** (advance or payment), **Charge / discount**, **Reverse**. Managers see it read-only |
| **Payments** (new menu item) | Pending payments, all job accounts, payment history, vendor-wise totals with **payment statements**, monthly and financial-year payments with a chart; Excel export everywhere |
| **Vendor page** | Payments card (payable, paid, outstanding) with the payment statement |
| **Vendor Reliability** | The quality factor (25%) now works from inspected pieces; quality acceptance and rework/rejection % with piece counts |

Screenshots: `docs/screenshots/29-*.png` to `37-*.png`.

## Rules enforced by the database
- Returns, inspections, payments, charges and discounts are never edited or deleted (also not by the database owner); corrections
  are voids (returns, inspections) or reversals (money), always with a reason, all in the Activity History.
- Over-returns, over-inspection, future dates and overpayment are refused; the quantity sent cannot drop below what is back.
- A job completes only when every piece is back and inspected, or when an authorised user closes it with a reason; a closed job can
  be reopened only through "Reopen job" with a reason.
- Payments: Admin only by default; Managers view only; Staff see nothing (checked on the server, Example 10).

## Tests (run 2026-11-03)
| Suite | Result |
|---|---|
| Unit | 61 / 61 |
| Integration (real local Supabase; 16 Phase 6 tests: **Example 3**, **Example 4**, rework, automatic completion, not completed while awaiting inspection, close with reason, reopen and void, unknown quantity, **Example 5** with charges/discount, overpayment, reversal, Fully Paid, Manager view-only and Staff blocked (**Example 10**), vendor-wise / monthly / statement, quality factor in reliability) | 91 / 91 (all phases) |
| Browser (Playwright): 60 of 100 returned, 55/5 inspection, rest returned and inspected → Completed; Manager sees payments read-only; Admin invoice ₹50,000, advance ₹20,000, payment ₹15,000 → balance ₹15,000, overpayment blocked, statement download; phone layout | 15 / 15 (all phases) |
| Type check, production build | clean |

Fixed during testing: after the last return completed a job, the return dialog closed without showing "the job is now Completed".

## Decisions I made that you may want to change
1. **Automatic completion counts rejected pieces as decided.** When every piece is back and inspected, the job completes even if some
   were rejected (the rejections are recorded and lower the vendor's quality score). If you prefer that any rejection keeps the job open
   until someone closes it with a reason, it is a one-line change.
2. **Rework goes back to the vendor**: rework pieces count as "with vendor" again and must come back and be inspected before the job can
   complete. Reworked pieces count again in the quality %, so the first failure is not hidden.
3. **Manual close uses the last return date** as the completion date (for on-time scoring), even if some pieces never came back.
4. **Payments are per vendor assignment**: if a job was forwarded, the first vendor can still be paid for work done. The job amount
   is the payable base; recording the vendor's invoice sets it to the invoice amount.
5. **Vendor-wise totals by financial year** use the year the job was given; **monthly / FY payments** use the payment date.

## Not in this phase
- WhatsApp click-to-chat (including payment confirmation and quality/rework follow-up messages) and reminders: **Phase 7**.
- Dashboard and weekly reports (including PDF): **Phase 8**. Deployment: **Phase 9** (needs your accounts).
