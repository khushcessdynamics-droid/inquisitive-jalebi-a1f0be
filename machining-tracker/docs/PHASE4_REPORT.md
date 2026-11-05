# Phase 4 report: jobs, vendors, reassignment history, attachments, Excel import/export

Status: **complete and tested locally** (not deployed).

## What you can do now
| Screen | What it does |
|---|---|
| **Jobs Register** | Quick tabs with counts (Open, Overdue, Due today/soon, No commitment date, Drafts, Completed, Cancelled, All, Archived); search by job ID, part or vendor; filters for category, vendor, financial year and date range; sortable columns; pages of 25; **Export to Excel** of exactly what is filtered |
| **New Job** | Combined Part No / Part Name with autocomplete and "outsourced N times before" hint; quantity, category, Given By, Assigned Staff User, remarks; give to a vendor now (date given, committed date, amount) or save as Draft. Vendors that do the chosen category are listed first |
| **Job page** | Key dates kept separately (given, original commitment, current commitment, return), day counts, vendor journey timeline, job history, other jobs for the same part, attachments |
| Actions on a job | Edit (full for Manager/Admin; description, remarks, unknown quantity for Staff on their jobs) · Send to vendor (Drafts) · Record committed date (once; then locked) · Correct vendor/date (with reason) · **Cancel / forward to another vendor** (reason mandatory, vendor-caused or not) · Archive (Admin) |
| **Vendors** | Vendor master with automatic codes (V-0001), categories, contacts, WhatsApp number, GST, payment terms, active/inactive; vendor page with job counts, vendor-caused vs other cancellations and job list; Export to Excel |
| **Missing Data Review** | Jobs without quantity, commitment date or amount, and imported cancellations without a reason (classify them once) |
| **Excel Import / Export** | Reads the original `CESS_Machining_Job_Tracker.xlsx` layout (ENTRY + VENDORS) or the new templates; server-checked preview before anything is saved; duplicates skipped; cancel-and-forward rows rebuilt as one job; templates to download |

Status and day-count rules: `docs/STATUS_RULES.md`.

## Rules enforced by the database (cannot be bypassed through the API)
- One open vendor per job; a cancelled assignment can never be edited; nothing can be deleted.
- Original commitment date is set once and never changes (revisions arrive with Phase 5's commitment history).
- Cancellation needs a reason code and description; the new vendor must differ and cannot receive the job before the cancellation date.
- Staff see only jobs they created or are assigned to; vendors and attachments follow the same visibility.
- Attachments: private storage, allowed file types and size from Settings, no overwrite or delete, archive with reason; downloads use 60-second links and are logged.
- Imports: preview validates every row on the server; missing quantity/commitment stay empty; imported completed jobs are closed with a recorded note; cancellations without a reason are marked for classification and do not count against the vendor until classified.

## Tests (run 2026-11-03)
| Suite | Result |
|---|---|
| Unit (incl. Excel parsing of the real workbook, Indian date formats, chain rebuild, INR format) | 50 / 50 |
| Integration (real local Supabase; 17 Phase 4 tests incl. Example 1 statuses and Example 8 reassignment) | 55 / 55 |
| Browser (Playwright): vendors, new job, attachment upload, cancel & forward with vendor journey, register search, Excel import with preview (original layout), classify imported cancellation, phone layout | 8 / 8 |

## Not in this phase
- Commitment revisions with history and timeline, reliability score, cost comparison: **Phase 5**.
- Material returns, quality inspection, completing new jobs, payments: **Phase 6**.
- ExcelJS 4.4.0 (the specified library) has moderate npm-audit findings in two dependencies (minimatch, uuid) that do not
  apply to how the app uses it; npm's only automatic fix is downgrading to ExcelJS 3.4.0. Listed for the security report.
