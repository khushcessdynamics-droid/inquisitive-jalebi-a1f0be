# Database security configuration

Generated from the database by `scripts/security-docs.mjs` on 2026-11-03 (migrations up to 20261103000800). The live Supabase project gets
exactly this configuration from the same migrations (`supabase db push`).

## Summary

| Check | Result |
|---|---|
| Tables in the application schema | 32 |
| Tables with row-level security switched on | 32 of 32 |
| Tables an anonymous visitor may read or change | 0 |
| Functions an anonymous visitor may call | 0 of 70 |
| Tables signed-in users may change directly (without a checked function) | cancel_reason_codes (INSERT, UPDATE); given_by_names (INSERT, UPDATE); work_categories (INSERT, UPDATE): the master lists, only with *Change settings* (row-security policies); entries are never deleted; audited |
| Views that apply the caller's own row security (security invoker) | 9 of 9 |
| Privileged (security definer) functions | 103, all with a fixed search path: Yes |
| Internal `private` schema | Not published by the API (only `public` is). Anonymous visitors: no access. Signed-in users: 46 of 75 helper functions, used only inside row-security checks, views and triggers |
| File buckets | `job-files`: private, max 50 MB (3 storage policies) |
| Scheduled jobs | `cess-reminders` (*/15 * * * *, active), `cess-weekly-report` (*/15 * * * *, active) |

## How data is protected

- **Changes only through checked functions.** Signed-in users can read only the rows their row-security policies allow. Every
  business change goes through a database function that checks the permission (`private.require_permission`), validates the
  input, uses optimistic locking (`version`) and writes the activity history. Calling the API directly gives exactly the same
  checks as the app. The only direct writes are adding and renaming entries of the three master lists (work categories, Given By
  names, cancellation reasons), allowed by row-security policies only with *Change settings*; entries are never deleted.
- **Append-only records.** Payments, adjustments, commitment revisions, the activity history and other records marked below cannot
  be changed or deleted, not even by the database owner, without switching off the triggers (a deliberate superuser action).
  Corrections are made by reversal entries or voids with a reason.
- **Audit trail.** Tables marked *Audited* record who changed what, the previous and new values, the reason and the session.
- **MFA.** Admin and Manager have no access without a verified authenticator sign-in (`aal2`); this is checked inside the database.
- **Files.** Attachments are in a private bucket. Downloads need a short-lived signed link created for a signed-in user who may see
  that job; registered files cannot be deleted or overwritten through the API.

## Every table

| Table | Row security | Policies | Direct writes | Append-only / guarded | Audited |
|---|:-:|:-:|:-:|:-:|:-:|
| `activity_log` | Yes | 1 | No | Yes | — |
| `app_settings` | Yes | 1 | No | Yes | Yes |
| `attachments` | Yes | 1 | No | Yes | Yes |
| `backup_runs` | Yes | 1 | No | — | — |
| `cancel_reason_codes` | Yes | 3 | **Yes** | Yes | Yes |
| `commitment_revisions` | Yes | 1 | No | Yes | — |
| `given_by_names` | Yes | 3 | **Yes** | Yes | Yes |
| `import_batches` | Yes | 1 | No | Yes | — |
| `job_assignments` | Yes | 1 | No | Yes | Yes |
| `jobs` | Yes | 1 | No | Yes | Yes |
| `material_returns` | Yes | 1 | No | Yes | Yes |
| `message_templates` | Yes | 2 | No | Yes | Yes |
| `notifications` | Yes | 1 | No | — | — |
| `number_counters` | Yes | 0 | No | — | — |
| `payment_adjustments` | Yes | 1 | No | Yes | Yes |
| `permissions` | Yes | 1 | No | — | — |
| `profiles` | Yes | 1 | No | Yes | Yes |
| `quality_inspections` | Yes | 1 | No | Yes | Yes |
| `quotation_requests` | Yes | 1 | No | Yes | Yes |
| `reminder_runs` | Yes | 1 | No | — | — |
| `reminders` | Yes | 1 | No | Yes | Yes |
| `role_permissions` | Yes | 1 | No | — | Yes |
| `roles` | Yes | 1 | No | — | Yes |
| `session_activity` | Yes | 0 | No | — | — |
| `user_permission_overrides` | Yes | 1 | No | — | Yes |
| `vendor_categories` | Yes | 1 | No | — | Yes |
| `vendor_payments` | Yes | 1 | No | Yes | Yes |
| `vendor_quotations` | Yes | 1 | No | Yes | Yes |
| `vendors` | Yes | 1 | No | Yes | Yes |
| `weekly_reports` | Yes | 0 | No | Yes | — |
| `whatsapp_messages` | Yes | 1 | No | Yes | Yes |
| `work_categories` | Yes | 3 | **Yes** | Yes | Yes |

## Every view

| View | Applies the caller's row security |
|---|:-:|
| `assignment_quantities` | Yes |
| `commitment_history` | Yes |
| `job_register` | Yes |
| `material_return_lots` | Yes |
| `payment_accounts` | Yes |
| `payment_ledger` | Yes |
| `quality_inspection_log` | Yes |
| `quality_records` | Yes |
| `whatsapp_log` | Yes |
