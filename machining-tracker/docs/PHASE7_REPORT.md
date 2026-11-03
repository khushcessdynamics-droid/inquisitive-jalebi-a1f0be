# Phase 7 report: WhatsApp communication, reminder engine, notifications

Status: **complete and tested locally** (not deployed). How it works: `docs/WHATSAPP_AND_REMINDERS.md`.

## What you can do now
| Screen | What it does |
|---|---|
| **Job page > WhatsApp** | Prepared message from the template that fits the job's status (overdue, due today, partial return ...), filled with the job's facts, editable; shows the vendor's number; **Open WhatsApp** opens the chat with the text and you press Send; "I pressed Send in WhatsApp" records your confirmation; warning when the same message was opened in the last 12 hours |
| **Job page > WhatsApp with the vendor** | The job's message history (opened / marked as sent, by whom, when, full text) |
| **Payments > Confirm on WhatsApp** | Payment confirmation with amount, date, mode, reference and balance |
| **WhatsApp** (new menu item) | **Follow-ups due**: every overdue, due-today, due-soon, partially returned or undated job with a one-click WhatsApp; **Message history** for all vendors |
| **Notifications** (new menu item with live unread count; bell on phones) | Reminders from the server engine with severity, job link, one-click WhatsApp, mark read / mark all read; **reminders in the next 7 days**; for Admin the engine status and **Run reminders now** |
| **Settings > Reminders** | Days before, on the day, first overdue reminder, repeat daily, run time (IST), on/off, with a preview of the schedule |
| **Settings > WhatsApp** | Default country code; mode (click-to-chat); the ten templates with placeholders list, live preview and unknown-placeholder check |
| **Vendor page** | WhatsApp history with the vendor |

Screenshots: `docs/screenshots/38-*.png` to `45-*.png`.

## Rules enforced by the server
- WhatsApp history and reminders are append-only (only your "sent" confirmation can be added to a message, once); every opening and every
  reminder is in the Activity History.
- The reminder engine runs in the database every 15 minutes (pg_cron), creates each reminder once (unique per job, day and type), never
  for jobs without a committed date, with nothing left at the vendor, completed, cancelled or archived; it always uses the latest
  committed date.
- Notifications are private to each user; Staff get only reminders for jobs assigned to them or created by them.
- Templates can be changed only with "Change settings"; WhatsApp only with "Open WhatsApp messages to vendors" (Admin and Manager).

## Tests (run 2026-11-03)
| Suite | Result |
|---|---|
| Unit (adds number normalisation, wa.me link, template filling with [missing], payment values, reminder schedule = database rule) | 69 / 69 |
| Integration (real local Supabase; 10 Phase 7 tests: templates and edit rights, message facts, opened-not-sent log, duplicate confirmation, append-only history, the schedule on a fixed date and time, run-time gate, no duplicates, recipients, private notifications, recalculation after a revision, stop on completion / return / cancellation, switching off, scheduler present, Admin-only run-now) | 101 / 101 (all phases) |
| Browser (Playwright): overdue WhatsApp message with edit, exact wa.me link, mark as sent, history, duplicate warning; notification from the engine with unread badge and one-click WhatsApp; reminder settings preview and template editing; phone layout | 19 / 19 (all phases) |
| Type check, production build | clean |

## Decisions I made that you may want to change
1. **Who gets reminder notifications**: Admin and Manager (everyone who sees all jobs) plus the job's Assigned Staff User / creator.
   If Managers should only get reminders for their own jobs, or everyone should be able to mute them, tell me.
2. **Duplicate window** for WhatsApp: 12 hours for the same template, vendor and job.
3. **No vendor reminders once everything is back** with CESS (awaiting inspection): the follow-up is then internal.
4. **Run time 09:00 IST**, checked every 15 minutes (so a reminder can appear up to 15 minutes after the set time).

## Not in this phase
- Automatic WhatsApp sending (Business Cloud API): needs your Meta account, approved templates and vendor consent (`docs/SETUP_ACCOUNTS.md` section 6).
- Dashboard (upcoming / due today / overdue cards) and weekly reports with PDF/Excel: **Phase 8**.
