# Phase 4 progress (paused 2026-11-02, to continue next session)

Phase 4 = jobs, vendors, cancel & forward history, attachments, Excel import/export.

## Done and tested
| Part | Status |
|---|---|
| Database (migrations `20261103000100_jobs_vendors.sql`, `20261103000200_jobs_rpcs.sql`) | Done |
| Vendors: master with automatic codes (V-0001), categories, validation, active/inactive | Done |
| Jobs: combined Part No / Part Name; Given By, Created By, Assigned Staff User kept separate; job numbers JOB-2627-0001 per financial year | Done |
| Vendor assignments: one open vendor per job; cancel & forward keeps the full vendor journey; mandatory reason; original commitment date can never change | Done |
| Status and day counts calculated live in Indian time (Draft, Sent to Vendor, In Progress, Due Soon, Due Today, Overdue, Commitment Date Missing, Completed, Cancelled) | Done |
| Visibility: Staff see only jobs they created or are assigned to; Managers/Admin see all | Done |
| Attachments: private bucket, file-type and size checks, only the job's people can upload/download, no overwrite or delete, archive with reason | Done |
| Excel import (server side): preview without saving, duplicate detection, legacy cancel-and-forward chains, completed rows closed with a recorded reason, unknown cancellation reasons flagged for review, missing quantity/commitment kept empty | Done |
| Shared import logic: original workbook layout + templates, Indian date formats, chain rebuild; tested against the real `CESS_Machining_Job_Tracker.xlsx` | Done |
| Tests | Unit 50/50, integration 55/55 (17 new for Phase 4), typecheck clean, build OK |

## Still to do (next session)
1. **Screens** (the database functions they call already exist and are tested):
   - Jobs Register: quick filters (open, overdue, due, missing date, drafts, completed, cancelled, archived), search, filters, sorting, pages, Excel export
   - New Job form (part autocomplete, vendor, dates, amount, assigned staff)
   - Job detail: key dates, vendor journey, cancel & forward, record commitment date, edit, archive, attachments, job timeline, other jobs for the same part
   - Vendors list, vendor form, vendor page with basic counts
   - Missing Data Review (classify imported cancellations, fill missing data)
   - Excel Import / Export page (preview table, options, templates, vendor master export)
   - Sidebar entries for these pages
   Started: shared UI pieces in `apps/web/src/lib/excel.ts`, `hooks/master.ts`, `components/jobs.tsx`, types in `lib/types.ts`.
2. Browser (Playwright) tests for: create vendor, create job, cancel & forward, import preview/import.
3. Update `PHASE3_REPORT.md` / README and the PR, then push.

## Known notes
- ExcelJS 4.4.0 (the specified library) pulls in dependencies with moderate npm-audit findings (minimatch ReDoS with
  attacker-supplied glob patterns; uuid buffer check in unused versions). They do not apply to how the app uses it; the
  only automatic "fix" is downgrading to the older ExcelJS 3.4.0. To be listed in the dependency report.
- Material returns, quality inspection and payments (Phase 6) will add "Partially Returned" and
  "Quality Inspection Pending" and the normal way of completing a job. Until then only imported historical jobs can be Completed.

## How to resume
In a new session: `cd machining-tracker && npm ci && npm run db:start`, then continue with item 1 above.
