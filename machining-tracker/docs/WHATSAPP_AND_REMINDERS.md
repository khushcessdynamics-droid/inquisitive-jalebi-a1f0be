# WhatsApp, reminders and notifications: how they work

## 1. WhatsApp click-to-chat (the mode in use)
- On a job (button **WhatsApp**), on a payment entry (**Confirm on WhatsApp**), from a notification or from the WhatsApp page, the app
  prepares a message from a template, fills in the facts of the job and shows it for editing.
- **Open WhatsApp** opens WhatsApp Web or the WhatsApp app (`https://wa.me/<number>?text=...`) with the vendor's chat and the text
  already typed. **You press Send in WhatsApp.**
- The app records the message as **"Opened in WhatsApp (not confirmed)"**. It cannot see whether WhatsApp sent or delivered it and
  never claims so. After sending, you can press **"I pressed Send in WhatsApp"**: the record then says "Marked as sent by <you>".
- The communication history (job page, vendor page, WhatsApp page) keeps every message with job, vendor, number, text, who and when.
  It cannot be edited or deleted. Every opening also appears in the Activity History ("WhatsApp opened with a message").
- **Duplicate protection**: the same template for the same vendor and job within 12 hours asks "already opened at ... by ...; open again?".
- Number: the vendor's WhatsApp number (or the mobile number if empty) with the vendor's country code (default +91, Settings > WhatsApp).
  "98220 12345", "098220-12345", "+91 98220 12345" and "919822012345" all become 919822012345.
- **Who**: users with "Open WhatsApp messages to vendors" (Admin and Manager by default; can be granted to Staff).

### Templates (Settings > WhatsApp)
New job assignment · Job status follow-up · Upcoming delivery reminder · Due today reminder · Overdue job reminder · Commitment date
confirmation · Revised delivery date confirmation · Material return reminder · Quality / rework follow-up · Payment confirmation.

Placeholders: `{vendor_name} {contact_person} {company} {job_no} {part} {qty} {date_given} {original_commitment} {current_commitment}
{delay_days} {delay_days_original} {pending_qty} {returned_qty} {accepted_qty} {rejected_qty} {rework_qty} {payment_amount}
{payment_date} {payment_mode} {payment_reference} {balance}`. A fact that is not recorded appears as **[missing: ...]** and a warning
is shown, so nothing is invented. Unknown placeholders cannot be saved. The editor shows a live preview; every change is in the
Activity History. `{contact_person}` falls back to the vendor name; `{delay_days}` counts against the current (latest) committed date.

The app suggests the template that fits: Overdue → overdue reminder, Due today → due today, Due soon → upcoming, Partially returned →
material return reminder, Sent to vendor → commitment confirmation (new job assignment when no date is known), Completed with
rejections → quality follow-up, payment entry → payment confirmation. You can choose any other.

### Automatic sending (WhatsApp Business Cloud API): not active
Needs a Meta Business account, a verified business phone number, approved message templates and the vendors' opt-in. The access token
would be kept only on the server (an Edge Function secret), never in the website. Status would come from Meta's delivery webhooks
(queued, accepted, sent, delivered, read, failed). It stays off until you provide these and switch it on explicitly; the settings
refuse "automatic WhatsApp" until then. Steps: `docs/SETUP_ACCOUNTS.md` section 6.

## 2. Reminder engine
- Runs **in the database on the server** (pg_cron, job `cess-reminders`, every 15 minutes). The first check at or after the configured
  time (default **09:00 IST**) creates the day's reminders. It works without anyone having the app open and continues after restarts.
- Schedule (Settings > Reminders, with a preview): **3 and 1 day before** the committed date, **on the date**, **1 day overdue**, then
  **every day** until the job is completed or cancelled. All configurable.
- Uses the **latest** committed date, so a revision moves future reminders automatically (already created reminders stay in the history).
- **No reminders** for jobs without a committed date, when nothing is left with the vendor (everything returned, e.g. waiting for
  inspection), or for completed, cancelled or archived jobs.
- **No duplicates**: one reminder per job, day and type (database unique rule), however often the engine runs.
- Each reminder is in the Activity History of the job ("Reminder generated", by "Reminder engine (automatic)").
- **Run reminders now** (Admin, Notifications page) runs immediately regardless of the time; it never creates duplicates.

## 3. Notifications
- Each reminder becomes an in-app notification for every user who sees all jobs (Admin, Manager) and for the job's **Assigned Staff
  User** and creator when they are Staff. Other Staff do not get it.
- The bell / **Notifications** menu shows the unread count live. The Notifications page lists unread or all, with a link to the job and a
  one-click **WhatsApp** follow-up (template chosen from the reminder type), **Mark read** and **Mark all as read** (only your own).
- **Reminders in the next 7 days** shows what the engine will create, calculated from the current dates.
- Admin sees the engine status (scheduled, run time, last runs with counts).

## 4. Hosting note (Supabase Free)
pg_cron ("Supabase Cron") is available on hosted Supabase projects. A Free project is **paused after a week of low activity**; a paused
project runs no reminders. Normal daily use and the daily backup from your PC keep it active.
