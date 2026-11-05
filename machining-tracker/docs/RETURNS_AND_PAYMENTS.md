# Material returns, quality inspection, job completion and vendor payments: the exact rules

All quantities, statuses and balances are calculated by the database from the recorded entries every time a screen opens.
Nothing is overwritten: returns and inspections are **voided** with a reason, payments and charges are **reversed** with a reason.

## 1. Quantities (per vendor assignment of a job)
| Figure | Calculation |
|---|---|
| Sent | quantity given to this vendor (empty when not recorded) |
| Returned | sum of the returns (voided returns excluded) |
| Accepted / Rejected / Sent for rework | sums of the inspections (voided inspections excluded) |
| Awaiting inspection | returned − (accepted + rejected + rework) |
| **With vendor** (pending) | sent − returned + sent back for rework |
| Quality acceptance % | accepted ÷ inspected pieces; rejection % and rework % the same way |

Example 3: 100 sent, 60 returned → **40 with the vendor** (and 60 awaiting inspection until inspected).
Example 4: of those 60, **55 accepted and 5 rejected** → shown separately; acceptance 91.7%, rejection 8.3%.

Checks: a return cannot exceed what is with the vendor; an inspection cannot exceed what is still uninspected in that return;
return and inspection dates cannot be in the future or before the date given / the return date; the quantity sent can never be
lowered below what is already back.

## 2. Inspection status (per inspection and per return)
Inspection Pending (pieces still uninspected) · Accepted (all accepted) · Partially Accepted (some accepted, some rejected or rework) ·
Rework Required (none accepted, some for rework) · Rejected (all rejected). Who inspected (name), date and remarks are kept.
Rework pieces go back to the vendor: they count as "with vendor" again and are expected in a later return, which is inspected again.

## 3. When is a job completed?
- **Automatically** when nothing is with the vendor and nothing is awaiting inspection, i.e. every piece sent was finally accepted or
  rejected. The completion reason is recorded, e.g. "All 100 pieces returned and inspected: 95 accepted, 5 rejected." The completion
  date is the date of the **last return** (used for on-time delivery and delay).
- **By an authorised user with a reason** (Close job; jobs.edit): when the rest will not come (remaining pieces not needed), the quantity
  was never recorded, or similar. Not allowed while returned pieces are awaiting inspection, and not before anything has been returned
  (cancel the vendor assignment instead).
- A return date alone never completes a job.
- **Reopen job** (with a reason) makes the last vendor assignment open again so a mistaken return or inspection can be voided and
  re-entered. Everything recorded stays in the history.

## 4. Vendor payments (one account per vendor assignment)
| Figure | Calculation |
|---|---|
| Job amount | the amount on the vendor assignment; **Record vendor invoice** sets it to the invoice amount (with invoice number and date) |
| Additional charges / Discount | sums of the charge and discount entries (reversals subtract) |
| **Total payable** | job amount + additional charges − discount |
| Advance paid | sum of the advances |
| Amount paid | sum of all advances and payments (reversals subtract) |
| **Balance** | total payable − amount paid |

**Payment status**: Unpaid (nothing paid) · Advance Paid (only advances so far) · Partially Paid · Fully Paid (paid ≥ payable).

Example 5: invoice ₹50,000; advance ₹20,000 + payment ₹15,000 → paid ₹35,000, **balance ₹15,000**, Partially Paid.

Rules:
- A payment can never exceed the balance; a discount can never bring the payable below what is already paid.
- Before a job amount exists only an **advance** can be recorded.
- Payment entries get numbers (PAY-2627-0001). They are never edited or deleted, not even by the database owner: a mistake is
  corrected by **Reverse** (a negative entry linked to the original, with the reason). A reversal cannot be reversed; record a new
  payment instead.
- Once money is recorded for a vendor assignment, its job amount can be changed only through Record vendor invoice (Admin, with a reason).

**Who can do what** (server-checked): Admin records invoices, payments, charges and discounts (payments.add) and reverses them or
changes a recorded invoice amount (payments.manage). Managers **view** payments only. Staff do not see payments. Any of these can be
granted to a person as an exception in Roles & Permissions.

## 5. Reports
- **Pending payments**: every account with a balance, oldest first (option: only completed work); Excel export.
- **All job accounts**: filter by vendor, payment status and the financial year the job was given; Excel export.
- **Payment history**: every advance, payment, charge, discount and reversal with mode, reference and who recorded it; Excel export.
- **Vendor-wise**: total payable, total paid, outstanding per vendor (optionally for jobs given in one financial year) and the
  **payment statement**: opening balance, every job amount / charge / discount / payment in the chosen dates with a running balance,
  closing balance; Excel download.
- **Monthly / financial year**: money paid per month of a financial year (by payment date, reversals subtracted) with a chart,
  and the total per financial year.
