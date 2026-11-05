# Phase 1 — Workbook Analysis: CESS_Machining_Job_Tracker.xlsx

Source: Drive `Machining_Job_Tracker/CESS_Machining_Job_Tracker.xlsx` (256,816 bytes).
Original kept untouched in `legacy/`; `.BACKUP.xlsx` is an identical copy (same SHA-256).

## Key finding
The workbook is an **empty template**: ENTRY (`tblJobs`) and VENDORS (`tblVendors`) have **zero data rows**.
Only SETTINGS lists contain data. There is nothing to migrate except those lists, but the
Excel importer must still support the column layout below for future/other workbooks.

## Sheets
| Sheet | Range | Purpose |
|---|---|---|
| ENTRY | table `tblJobs` A5:W6 | One row per job assignment (permanent record) |
| VENDORS | table `tblVendors` A5:AA6 | Vendor master + auto stats/ranking |
| SETTINGS | B/D lists | Work categories (11), Given By (3) |
| Dashboard | B1:BC1005 | KPIs, vendor summaries, monthly spend, cancelled list, ranking, vendor/part search, full history; 3 charts; helper columns T–BC |

## ENTRY columns
Input: Part No / Name, Date Given to Vendor, Date Returned by Vendor, Vendor Name, Given By,
Work / Machining Process, Amount (₹), Cancelled On, Forwarded To, Remarks.
Formula: Sr No; Days Taken; Status; hidden helpers h_* (dedupe/ranking plumbing — not business data).
Validation: date given 2015-01-01..today+1; returned/cancelled must be >= given and <= today+1;
amount >= 0; vendor/forwarded-to/work/given-by from lists.

## Existing business rules (extracted from formulas)
1. **Status**: Cancelled if `Cancelled On` set; else Pending if no return date; else Completed.
2. **Days Taken** = (Returned, else Cancelled On, else TODAY) − Date Given.
3. **Late** = Pending and Days Taken > LateDays (Dashboard!O9, default **10**, user-editable).
4. **Re-outsourcing**: old row gets `Cancelled On` + `Forwarded To`; a NEW row is added for the new vendor
   (matches your parent/linked-assignment requirement). `h_fwdmiss` flags a forward with no matching new row.
5. **Vendor stats**: Total/Completed/Pending/Cancelled counts, Avg Return Days (completed only), spend.
6. **Ranking**: per Work Category, on jobs *closed* in the period (returned or cancelled; cancelled counts with days held);
   lower avg days = better, tie → more jobs. Periods: This Month / Last Month / Overall (+ period list).
7. **Financial year**: Apr–Mar. Spend by Date Given month.
8. Vendor name must be unique; GST field length 15.
9. Renaming categories/vendors does not rewrite history (old rows show in red).

## SETTINGS data to preserve
Work categories (11): CNC Turning, VMC Machining, Wire EDM, Grinding, Laser Cutting & Bending,
Welding & Fabrication, Heat Treatment, Surface Finishing, Drilling & Tapping, Gear Cutting, Others.
Given By: Samyak, Vansh, Sanjay.

## Gaps vs. your spec (new in the app, no Excel equivalent)
Commitment dates, quantities/partial returns, quality inspection, payments, quotations, WhatsApp,
reminders, audit log, weekly reports, reliability score, attachments. Vendor sheet has single category,
no contact person / mobile / WhatsApp / payment terms / active flag.

## Data-quality / consistency notes
- Excel's cancelled-job ranking counts *all* cancellations as closed (your spec says only vendor-failure cancellations
  are excluded or included — needs your rule, Q4).
- No quantity column exists: existing jobs will import with Quantity = unknown (NULL), not 0 or 1.
- No commitment date: imported jobs get no due date → no Overdue/Due Soon status; legacy "Late" (>10 days) kept as a separate flag.
- `Part No / Name` is a single combined field; split into Part Number / Part Name needs a rule (Q5).
- Vendor "Phone No" maps to Mobile; WhatsApp number left blank until confirmed.
