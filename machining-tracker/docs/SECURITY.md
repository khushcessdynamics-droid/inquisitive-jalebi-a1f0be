# Security design (Phase 3 foundation)

## Architecture

```
Browser (React app, static files on Cloudflare, HTTPS, strict CSP)
   │  publishable key + user's JWT
   ▼
Supabase API gateway ──► PostgREST ──► PostgreSQL (Row Level Security on every table,
   │                                     permission-checked SECURITY DEFINER functions,
   │                                     append-only activity log, audit triggers)
   ├──► Supabase Auth (bcrypt passwords, TOTP MFA, rate limits)
   └──► Edge Function admin-users (only place that uses the secret key; re-checks permission as the caller)
```
- No custom backend server. All business rules that protect data run **inside PostgreSQL**, so direct API calls get exactly the same checks as the app.
- The browser holds only the public URL and publishable key.

## Authentication
| Control | Implementation |
|---|---|
| Accounts | Invitation only (public sign-up disabled). New Auth users start **inactive** until an Admin activates them |
| First Admin | `private.bootstrap_first_admin()` from the Supabase SQL editor; works once; not callable through the API |
| Password storage | Supabase Auth, **bcrypt** (Argon2id is not available in Supabase Auth; bcrypt is an accepted strong algorithm) |
| Password policy | Minimum 12 characters, lower + upper case + digit (Supabase Auth setting) |
| MFA | TOTP authenticator app. **Mandatory for Admin and Manager** (database constraint). Optional for Staff, but once a user enrols, MFA is required on every sign-in. Admin can make it mandatory for Staff |
| Brute force | Supabase per-IP rate limit (30 sign-ins per 5 min); CAPTCHA (Turnstile) at deployment. Per-account lockout needs a Team-plan hook and is **not available on Free** |
| Password reset | Emailed link (if SMTP configured) or Admin-created one-time link. A reset never bypasses MFA |
| Links | `token_hash` links verified by `/auth/confirm`; the token is removed from the address bar immediately; links are single-use and never logged |

## Sessions
| Control | Implementation |
|---|---|
| Revocation | Every request checks that the JWT's `session_id` still exists in `auth.sessions` (`private.session_ok`). Sign-out, "sign out on all devices", deactivation, role change and Admin "end sessions" delete sessions, so the access token stops working **immediately** |
| Idle timeout | Server-side: the app sends a heartbeat (`touch_session`); after the configured idle time (default 30 min) the database rejects the session and deletes it. The browser also signs out locally |
| Maximum session length | Default 12 h, enforced by the database |
| Deactivation | Profile inactive + Auth ban + all sessions deleted, in one transaction |

## Authorization
- Roles: Admin, Manager, Staff/Operator. Permissions are rows in `permissions` / `role_permissions`, with per-user exceptions in `user_permission_overrides`. All changes are audited and need a reason.
- `users.manage` and `backups.manage` are **Admin-only** and can never be granted to anyone else (prevents privilege escalation).
- Every table has RLS. Writes to sensitive tables go only through functions that call `private.require_permission()`.
- The menu hides pages a user cannot use, but the server check is what protects the data.

### Default permission matrix
| Permission | Admin | Manager | Staff |
|---|---|---|---|
| View all jobs | ✔ | ✔ | — |
| View jobs assigned to me / created by me | ✔ | — | ✔ |
| Create jobs | ✔ | ✔ | ✔ |
| Edit jobs (all fields) | ✔ | ✔ | — |
| Edit operational fields on my jobs | ✔ | — | ✔ |
| Archive jobs | ✔ | — | — |
| Cancel jobs; change/forward vendor; revise commitments | ✔ | ✔ | — |
| View vendors | ✔ | ✔ | ✔ |
| Manage vendors, quotations; view reliability & cost comparison | ✔ | ✔ | — |
| Record returns; quality inspections; close / reopen jobs (with reason) | ✔ | ✔ | — (returns can be granted) |
| **View payments** | ✔ | ✔ | — |
| **Add payments, record invoices, charges and discounts** (payments.add) | ✔ | — (grantable) | — |
| **Reverse payments / change a recorded invoice amount** (payments.manage) | ✔ | — (grantable) | — |
| WhatsApp click-to-chat | ✔ | ✔ | — (grantable) |
| Attachments upload/download | ✔ | ✔ | ✔ (on permitted jobs) |
| Reports view/export | ✔ | ✔ | — |
| Activity history | ✔ | — (grantable) | — |
| Settings & master lists | ✔ | — (grantable; session security always Admin) | — |
| System health | ✔ | — (grantable) | — |
| Users, roles, permissions; backups | ✔ only | — | — |

Job visibility for Staff uses the separate **Assigned Staff User** field (kept apart from **Given By** and **Created By**), added with the Jobs module in Phase 4.

## Audit trail
- `activity_log` is append-only: triggers block UPDATE, DELETE and TRUNCATE for every role including the service role and the database owner; table privileges are revoked as well.
- Generic audit triggers record actor, role, session, action, previous and new values (changed fields only) and the reason.
- Client-reported events (sign-in, exports, WhatsApp opened) are limited to a fixed list.
- Honest limit: a Supabase project owner using the SQL editor as superuser could disable triggers. Protect the Supabase account with MFA and keep it to the Admin.

## Data protection
- Supabase encrypts data at rest and in transit (TLS). The database is reached only through the API; no direct database port is used by the app.
- No secret in the frontend or in Git (`.gitignore` covers `.env*`). The Edge Function reads the secret key from Supabase's environment.
- Links and passwords are never logged. Error messages to users are generic; details stay server-side.

## Browser security
- Strict Content-Security-Policy (`script-src 'self'`, `connect-src` limited to the Supabase project, `frame-ancestors 'none'`), HSTS, nosniff, Referrer-Policy, Permissions-Policy (generated `_headers`).
- React escapes output; no `dangerouslySetInnerHTML`. Supabase tokens live in browser storage, so the CSP is the main XSS defence.
- CSRF: the API uses `Authorization` bearer tokens, not cookies, so classic CSRF does not apply. The Edge Function also rejects origins not on its allow-list.

## Known limitations on the free plan
1. No per-account lockout (needs Team plan); per-IP rate limit + CAPTCHA + MFA instead.
2. No leaked-password check (Pro).
3. Failed password attempts are not visible in the app (Supabase does not store them in the audit table).
4. No automatic backups from Supabase on Free: the local encrypted, verified backup tool covers this (`docs/BACKUP_AND_RECOVERY.md`). Backups contain password hashes and MFA secrets, so the backup key must be protected.
