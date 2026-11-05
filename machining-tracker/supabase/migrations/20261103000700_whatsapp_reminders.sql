-- =====================================================================================
-- Phase 7: WhatsApp click-to-chat with editable templates and a communication log, the backend reminder engine
-- (pg_cron, Asia/Kolkata), in-app notifications. Rules: docs/WHATSAPP_AND_REMINDERS.md.
-- Click-to-chat only opens WhatsApp with a prepared message: the person presses Send. Nothing here claims that a
-- message was sent or delivered. The WhatsApp Business Cloud API (automatic sending) stays off until configured.
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Message templates (editable in Settings)
-- ---------------------------------------------------------------------------
create table public.message_templates (
  key          text primary key check (key ~ '^[a-z_]{3,40}$'),
  label        text not null check (length(trim(label)) between 3 and 80),
  body         text not null check (length(trim(body)) between 10 and 2000),
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  version      integer not null default 1
);
create trigger message_templates_version before update on public.message_templates for each row execute function private.bump_version();
create trigger message_templates_no_delete before delete on public.message_templates for each row execute function private.forbid_delete();
create trigger message_templates_audit after insert or update on public.message_templates
  for each row execute function private.audit_row('key', 'settings');

select private.set_audit_context('system.seeded', 'Phase 7 message templates (migration 20261103000700)');
insert into public.message_templates (key, label, body, sort_order) values
  ('new_job', 'New job assignment',
   E'Dear {contact_person},\nWe have given you job {job_no}: {part}, {qty} pcs, on {date_given}.\nPlease confirm your delivery date.\n- {company}', 1),
  ('status_followup', 'Job status follow-up',
   E'Dear {contact_person},\nPlease share the status of job {job_no} ({part}). {pending_qty} pcs are pending with you; committed delivery date {current_commitment}.\n- {company}', 2),
  ('upcoming_reminder', 'Upcoming delivery reminder',
   E'Dear {contact_person},\nReminder: job {job_no} ({part}, {pending_qty} pcs) is due on {current_commitment}. Please confirm it will be delivered on time.\n- {company}', 3),
  ('due_today', 'Due today reminder',
   E'Dear {contact_person},\nJob {job_no} ({part}, {pending_qty} pcs) is due today, {current_commitment}. Please confirm the delivery time.\n- {company}', 4),
  ('overdue', 'Overdue job reminder',
   E'Dear {contact_person},\nJob {job_no} ({part}) was due on {current_commitment} and is {delay_days} days late. {pending_qty} pcs are still pending. Please share the delivery date urgently.\n- {company}', 5),
  ('commitment_confirmation', 'Commitment date confirmation',
   E'Dear {contact_person},\nPlease confirm: job {job_no} ({part}, {qty} pcs) will be delivered by {current_commitment}.\n- {company}', 6),
  ('revised_confirmation', 'Revised delivery date confirmation',
   E'Dear {contact_person},\nAs discussed, the delivery date of job {job_no} ({part}) is revised from {original_commitment} to {current_commitment}. Please confirm.\n- {company}', 7),
  ('return_reminder', 'Material return reminder',
   E'Dear {contact_person},\nPlease return the material for job {job_no} ({part}): {pending_qty} pcs are still pending with you.\n- {company}', 8),
  ('quality_followup', 'Quality / rework follow-up',
   E'Dear {contact_person},\nInspection of job {job_no} ({part}): {rejected_qty} pcs rejected and {rework_qty} pcs sent back for rework. Please arrange the rework and share the date.\n- {company}', 9),
  ('payment_confirmation', 'Payment confirmation',
   E'Dear {contact_person},\nPayment of {payment_amount} for job {job_no} ({part}) was made on {payment_date} by {payment_mode}, reference {payment_reference}. Balance: {balance}.\n- {company}', 10);
select private.set_audit_context(null, null);

-- ---------------------------------------------------------------------------
-- 2. WhatsApp communication log (click-to-chat: "opened in WhatsApp", never "sent" by itself)
-- ---------------------------------------------------------------------------
create table public.whatsapp_messages (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid references public.jobs (id),
  vendor_id        uuid not null references public.vendors (id),
  template_key     text references public.message_templates (key),
  phone            text not null check (phone ~ '^[0-9]{8,15}$'),
  body             text not null check (length(body) between 1 and 4000),
  mode             text not null default 'click_to_chat' check (mode in ('click_to_chat')),
  status           text not null default 'opened' check (status in ('opened', 'user_confirmed_sent')),
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  confirmed_at     timestamptz,
  confirmed_by     uuid,
  constraint whatsapp_confirmed check ((status = 'user_confirmed_sent') = (confirmed_at is not null))
);
create index whatsapp_messages_job_idx on public.whatsapp_messages (job_id, created_at desc);
create index whatsapp_messages_vendor_idx on public.whatsapp_messages (vendor_id, created_at desc);

-- only the "I sent it" confirmation can be added, once
create or replace function private.guard_whatsapp_message()
returns trigger language plpgsql set search_path = '' as $$
declare v_keep text[] := array['status', 'confirmed_at', 'confirmed_by'];
begin
  if tg_op = 'DELETE' then
    raise exception 'The WhatsApp history cannot be deleted.' using errcode = '42501';
  end if;
  if old.status <> 'opened' or (to_jsonb(new) - v_keep) is distinct from (to_jsonb(old) - v_keep) then
    raise exception 'The WhatsApp history cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger whatsapp_messages_guard before update or delete on public.whatsapp_messages
  for each row execute function private.guard_whatsapp_message();
create trigger whatsapp_messages_no_truncate before truncate on public.whatsapp_messages
  for each statement execute function private.forbid_change();
create trigger whatsapp_messages_audit after insert or update on public.whatsapp_messages
  for each row execute function private.audit_row('id', 'communication');

create view public.whatsapp_log with (security_invoker = true) as
select m.id, m.job_id, j.job_no, j.part_label, m.vendor_id, v.name as vendor_name, m.template_key, t.label as template_label,
       m.phone, m.body, m.mode, m.status, m.created_at, private.user_name(m.created_by) as opened_by_name,
       m.confirmed_at, private.user_name(m.confirmed_by) as confirmed_by_name
  from public.whatsapp_messages m
  join public.vendors v on v.id = m.vendor_id
  left join public.jobs j on j.id = m.job_id
  left join public.message_templates t on t.key = m.template_key;

-- Values for the template placeholders of one job (and optionally one payment). Dates are ISO; the screen formats them.
create or replace function public.whatsapp_context(p_job_id uuid, p_payment_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  j public.jobs;
  a public.job_assignments;
  v public.vendors;
  q record;
  p public.vendor_payments;
  acc record;
begin
  perform private.require_permission('whatsapp.send');
  if not private.can_view_job(p_job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  select * into j from public.jobs where id = p_job_id;
  select * into a from public.job_assignments where job_id = p_job_id order by (state = 'open') desc, sequence_no desc limit 1;
  if not found then
    raise exception 'This job has not been given to a vendor yet.' using errcode = '22023';
  end if;
  if p_payment_id is not null then
    select * into p from public.vendor_payments where id = p_payment_id and job_id = p_job_id;
    if not found then
      raise exception 'Payment not found for this job.' using errcode = 'P0002';
    end if;
    select * into a from public.job_assignments where id = p.assignment_id;
  end if;
  select * into v from public.vendors where id = a.vendor_id;
  select * into q from private.assignment_quantities(a.id);
  return jsonb_build_object(
    'job_id', j.id, 'assignment_id', a.id, 'assignment_state', a.state, 'vendor_id', v.id,
    'vendor_name', v.name, 'contact_person', nullif(v.contact_person, ''),
    'wa_country_code', v.wa_country_code, 'wa_number', nullif(v.wa_number, ''), 'mobile', nullif(v.mobile, ''),
    'company', nullif((select s.value ->> 'name' from public.app_settings s where s.key = 'company'), ''),
    'job_no', j.job_no, 'part', j.part_label, 'qty', coalesce(a.qty_sent, j.qty_sent),
    'date_given', a.dispatched_on, 'original_commitment', a.original_commitment_date, 'current_commitment', a.current_commitment_date,
    'delay_days', case when a.current_commitment_date is not null and a.state = 'open'
                       then greatest(0, private.today_ist() - a.current_commitment_date) end,
    'delay_days_original', case when a.original_commitment_date is not null and a.state = 'open'
                                then greatest(0, private.today_ist() - a.original_commitment_date) end,
    'pending_qty', q.with_vendor, 'returned_qty', q.received, 'accepted_qty', q.accepted, 'rejected_qty', q.rejected, 'rework_qty', q.rework,
    'payment', case when p.id is not null and private.has_permission('payments.view') then (
        select jsonb_build_object('amount', p.amount, 'paid_on', p.paid_on, 'mode', p.mode, 'reference', nullif(p.reference, ''),
                                  'balance', pa.balance, 'total_paid', pa.amount_paid, 'invoice_no', pa.invoice_no)
          from public.payment_accounts pa where pa.assignment_id = p.assignment_id) end,
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'template_key', m.template_key, 'created_at', m.created_at,
                                                            'status', m.status, 'opened_by_name', private.user_name(m.created_by))
                                         order by m.created_at desc)
                          from (select * from public.whatsapp_messages m2 where m2.job_id = j.id order by m2.created_at desc limit 10) m), '[]'::jsonb));
end;
$$;

-- Logs that WhatsApp was opened with this message (the person still has to press Send in WhatsApp).
-- The same template for the same vendor and job within 12 hours needs p_confirm_duplicate = true.
create or replace function public.log_whatsapp_message(
  p_vendor_id uuid, p_job_id uuid, p_template_key text, p_phone text, p_body text, p_confirm_duplicate boolean default false
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_prev public.whatsapp_messages; v_row public.whatsapp_messages; v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  perform private.require_permission('whatsapp.send');
  if p_job_id is not null and not private.can_view_job(p_job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.vendors where id = p_vendor_id) then
    raise exception 'Vendor not found.' using errcode = 'P0002';
  end if;
  if p_job_id is not null and not exists (select 1 from public.job_assignments where job_id = p_job_id and vendor_id = p_vendor_id) then
    raise exception 'This vendor did not work on this job.' using errcode = '22023';
  end if;
  if v_phone !~ '^[0-9]{8,15}$' then
    raise exception 'The WhatsApp number is not valid. Check the vendor''s country code and number.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 then
    raise exception 'The message is empty.' using errcode = '22023';
  end if;
  if p_template_key is not null and not exists (select 1 from public.message_templates where key = p_template_key) then
    raise exception 'Unknown message template.' using errcode = '22023';
  end if;
  select * into v_prev from public.whatsapp_messages m
   where m.vendor_id = p_vendor_id and m.job_id is not distinct from p_job_id
     and m.template_key is not distinct from p_template_key and m.created_at > now() - interval '12 hours'
   order by m.created_at desc limit 1;
  if found and not coalesce(p_confirm_duplicate, false) then
    raise exception 'This message was already opened in WhatsApp at % by %. Open it again?',
      to_char(v_prev.created_at at time zone 'Asia/Kolkata', 'HH24:MI DD-Mon'), coalesce(private.user_name(v_prev.created_by), 'someone')
      using errcode = 'PT409', hint = 'duplicate';
  end if;
  perform private.set_audit_context('whatsapp.initiated', null);
  insert into public.whatsapp_messages (job_id, vendor_id, template_key, phone, body)
  values (p_job_id, p_vendor_id, p_template_key, v_phone, trim(p_body))
  returning * into v_row;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_row);
end;
$$;

create or replace function public.confirm_whatsapp_sent(p_message_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare m public.whatsapp_messages;
begin
  perform private.require_permission('whatsapp.send');
  select * into m from public.whatsapp_messages where id = p_message_id for update;
  if not found or (m.job_id is not null and not private.can_view_job(m.job_id)) then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if m.status <> 'opened' then
    raise exception 'Already marked as sent.' using errcode = '22023';
  end if;
  perform private.set_audit_context('whatsapp.confirmed_sent', null);
  update public.whatsapp_messages set status = 'user_confirmed_sent', confirmed_at = now(), confirmed_by = auth.uid()
   where id = m.id returning * into m;
  perform private.set_audit_context(null, null);
  return to_jsonb(m);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reminder engine
-- ---------------------------------------------------------------------------
-- One row per reminder that was due (history; never changed). Unique per assignment, day and kind: no duplicates.
create table public.reminders (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null references public.job_assignments (id),
  job_id           uuid not null references public.jobs (id),
  vendor_id        uuid not null references public.vendors (id),
  kind             text not null check (kind in ('upcoming', 'due_today', 'overdue')),
  reminder_date    date not null,
  commitment_date  date not null,
  days_to_due      integer not null,
  pending_qty      integer,
  created_at       timestamptz not null default now(),
  unique (assignment_id, reminder_date, kind)
);
create index reminders_date_idx on public.reminders (reminder_date desc);
create index reminders_job_idx on public.reminders (job_id);
create trigger reminders_append_only before update or delete on public.reminders for each row execute function private.forbid_change();
create trigger reminders_no_truncate before truncate on public.reminders for each statement execute function private.forbid_change();
create trigger reminders_audit after insert on public.reminders for each row execute function private.audit_row('id', 'reminders');

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id),
  kind         text not null check (kind in ('reminder')),
  severity     text not null check (severity in ('info', 'warning', 'critical')),
  title        text not null,
  body         text not null default '',
  job_id       uuid references public.jobs (id),
  vendor_id    uuid references public.vendors (id),
  reminder_id  uuid references public.reminders (id),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  unique (user_id, reminder_id)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table public.reminder_runs (
  run_date               date primary key,
  first_run_at           timestamptz not null default now(),
  last_run_at            timestamptz not null default now(),
  runs                   integer not null default 1,
  reminders_created      integer not null default 0,
  notifications_created  integer not null default 0
);

-- Effective permission of any user (no session needed: used by the reminder engine to choose recipients).
create or replace function private.user_has_permission(p_user_id uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
             when p.role_key = 'admin' then true
             when perm.admin_only then false
             else coalesce(o.granted, rp.permission_key is not null)
           end
      from public.profiles p
      join public.permissions perm on perm.key = p_key
      left join public.user_permission_overrides o on o.user_id = p.id and o.permission_key = p_key
      left join public.role_permissions rp on rp.role_key = p.role_key and rp.permission_key = p_key
     where p.id = p_user_id and p.is_active
  ), false)
$$;

-- Which reminder (if any) is due today for a job whose latest committed date is p_due (settings from Settings > Reminders).
create or replace function private.reminder_kind(p_days_to_due integer, s jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_days_to_due > 0 and exists (select 1 from jsonb_array_elements(coalesce(s -> 'days_before', '[]')) d where (d #>> '{}')::int = p_days_to_due)
      then 'upcoming'
    when p_days_to_due = 0 and coalesce((s ->> 'on_due_date')::boolean, true) then 'due_today'
    when p_days_to_due < 0 and (-p_days_to_due = coalesce((s ->> 'overdue_after_days')::int, 1)
         or (coalesce((s ->> 'repeat_daily_when_overdue')::boolean, true) and -p_days_to_due > coalesce((s ->> 'overdue_after_days')::int, 1)))
      then 'overdue'
  end
$$;

-- Creates today's reminders and the users' notifications. Idempotent: running it again the same day adds nothing.
-- p_now is injectable for tests; the scheduler passes nothing (now()).
create or replace function private.run_reminders(p_now timestamptz default now(), p_force boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s jsonb := coalesce((select value from public.app_settings where key = 'reminders'), '{}'::jsonb);
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_today date := v_local::date;
  v_reminders integer := 0;
  v_notes integer := 0;
  v_n integer;
  r record;
  v_rem public.reminders;
  v_title text;
  v_sev text;
begin
  if not coalesce((s ->> 'enabled')::boolean, true) then
    return jsonb_build_object('ran', false, 'reason', 'Reminders are switched off in Settings.');
  end if;
  if not p_force and v_local::time < coalesce((s ->> 'run_time_ist')::time, time '09:00') then
    return jsonb_build_object('ran', false, 'reason', format('Reminders run at %s IST.', coalesce(s ->> 'run_time_ist', '09:00')));
  end if;

  for r in
    select a.id as assignment_id, a.job_id, a.vendor_id, a.current_commitment_date, j.job_no, j.part_label, v.name as vendor_name,
           j.assigned_staff_id, j.created_by, q.with_vendor,
           a.current_commitment_date - v_today as days_to_due,
           private.reminder_kind(a.current_commitment_date - v_today, s) as kind
      from public.job_assignments a
      join public.jobs j on j.id = a.job_id and j.closed_at is null and j.archived_at is null
      join public.vendors v on v.id = a.vendor_id
      cross join lateral private.assignment_quantities(a.id) q
     where a.state = 'open'
       and a.current_commitment_date is not null           -- no committed date: no reminders
       and coalesce(q.with_vendor, 1) > 0                  -- nothing left with the vendor: nothing to remind
  loop
    continue when r.kind is null;
    v_rem := null;
    perform private.set_audit_context('reminder.generated', null);
    insert into public.reminders (assignment_id, job_id, vendor_id, kind, reminder_date, commitment_date, days_to_due, pending_qty)
    values (r.assignment_id, r.job_id, r.vendor_id, r.kind, v_today, r.current_commitment_date, r.days_to_due, r.with_vendor)
    on conflict (assignment_id, reminder_date, kind) do nothing
    returning * into v_rem;
    perform private.set_audit_context(null, null);
    continue when v_rem.id is null;
    v_reminders := v_reminders + 1;
    v_title := case r.kind
      when 'upcoming' then format('%s due in %s day%s · %s', r.job_no, r.days_to_due, case when r.days_to_due = 1 then '' else 's' end, r.vendor_name)
      when 'due_today' then format('%s due today · %s', r.job_no, r.vendor_name)
      else format('%s overdue by %s day%s · %s', r.job_no, -r.days_to_due, case when r.days_to_due = -1 then '' else 's' end, r.vendor_name) end;
    v_sev := case r.kind when 'upcoming' then 'info' when 'due_today' then 'warning' else 'critical' end;
    -- recipients: everyone who sees all jobs, plus the assigned staff user and the creator when they may see the job
    insert into public.notifications (user_id, kind, severity, title, body, job_id, vendor_id, reminder_id)
    select p.id, 'reminder', v_sev, v_title,
           format('%s · committed %s%s', r.part_label, to_char(r.current_commitment_date, 'DD-Mon-YYYY'),
                  case when r.with_vendor is not null then format(' · %s pcs with the vendor', r.with_vendor) else '' end),
           r.job_id, r.vendor_id, v_rem.id
      from public.profiles p
     where p.is_active
       and (private.user_has_permission(p.id, 'jobs.view_all')
            or ((p.id = r.assigned_staff_id or p.id = r.created_by) and private.user_has_permission(p.id, 'jobs.view_assigned')))
    on conflict (user_id, reminder_id) do nothing;
    get diagnostics v_n = row_count;
    v_notes := v_notes + v_n;
  end loop;

  insert into public.reminder_runs (run_date, reminders_created, notifications_created) values (v_today, v_reminders, v_notes)
  on conflict (run_date) do update set last_run_at = now(), runs = public.reminder_runs.runs + 1,
     reminders_created = public.reminder_runs.reminders_created + excluded.reminders_created,
     notifications_created = public.reminder_runs.notifications_created + excluded.notifications_created;
  return jsonb_build_object('ran', true, 'date', v_today, 'reminders_created', v_reminders, 'notifications_created', v_notes);
end;
$$;

-- "Run now" from the Notifications page (Admin / settings.change): ignores the time of day, never duplicates.
create or replace function public.run_reminders_now()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_permission('settings.change');
  return private.run_reminders(now(), true);
end;
$$;

-- The reminders each open job will get from today (recalculated from the latest committed date every time).
create or replace function public.upcoming_reminders(p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s jsonb := coalesce((select value from public.app_settings where key = 'reminders'), '{}'::jsonb); v_today date := private.today_ist();
begin
  if not private.is_active_user() then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('date', d.day, 'kind', d.kind, 'job_id', x.job_id, 'job_no', x.job_no, 'part_label', x.part_label,
                                        'vendor_id', x.vendor_id, 'vendor_name', x.vendor_name, 'commitment_date', x.due, 'pending_qty', x.with_vendor)
                     order by d.day, x.due, x.job_no)
      from (select a.job_id, j.job_no, j.part_label, a.vendor_id, v.name as vendor_name, a.current_commitment_date as due, q.with_vendor
              from public.job_assignments a
              join public.jobs j on j.id = a.job_id and j.closed_at is null and j.archived_at is null
              join public.vendors v on v.id = a.vendor_id
              cross join lateral private.assignment_quantities(a.id) q
             where a.state = 'open' and a.current_commitment_date is not null and coalesce(q.with_vendor, 1) > 0
               and private.can_view_job(a.job_id)) x
     cross join lateral (
       select g::date as day, private.reminder_kind(x.due - g::date, s) as kind
         from generate_series(v_today, v_today + least(greatest(coalesce(p_days, 7), 0), 31), interval '1 day') g
     ) d
     where d.kind is not null and coalesce((s ->> 'enabled')::boolean, true)), '[]'::jsonb);
end;
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_n integer;
begin
  if not private.is_active_user() then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.reminder_engine_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('system.view');
  return jsonb_build_object(
    'settings', (select value from public.app_settings where key = 'reminders'),
    'scheduled', exists (select 1 from cron.job where jobname = 'cess-reminders' and active),
    'schedule', (select schedule from cron.job where jobname = 'cess-reminders'),
    'last_runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.run_date desc) from (select * from public.reminder_runs order by run_date desc limit 7) r), '[]'::jsonb),
    'today', private.today_ist());
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Scheduler: every 15 minutes; the function itself waits for the configured time and never duplicates
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'cess-reminders') then
    perform cron.unschedule('cess-reminders');
  end if;
  perform cron.schedule('cess-reminders', '*/15 * * * *', 'select private.run_reminders()');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security, grants, realtime
-- ---------------------------------------------------------------------------
alter table public.message_templates enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.reminders enable row level security;
alter table public.notifications enable row level security;
alter table public.reminder_runs enable row level security;
revoke all on public.message_templates, public.whatsapp_messages, public.reminders, public.notifications, public.reminder_runs from anon, authenticated;
revoke update, delete, truncate on public.whatsapp_messages, public.reminders from service_role;
grant select on public.message_templates, public.whatsapp_messages, public.reminders, public.notifications, public.reminder_runs to authenticated;
grant update (label, body, is_active, sort_order) on public.message_templates to authenticated;

create policy message_templates_read on public.message_templates for select to authenticated using ((select private.is_active_user()));
create policy message_templates_update on public.message_templates for update to authenticated
  using ((select private.has_permission('settings.change'))) with check ((select private.has_permission('settings.change')));
create policy whatsapp_messages_read on public.whatsapp_messages for select to authenticated using (
  (select private.has_permission('whatsapp.send')) and (job_id is null or exists (select 1 from public.jobs j where j.id = job_id))
  or (job_id is not null and (select private.has_permission('jobs.view_all'))));
create policy reminders_read on public.reminders for select to authenticated using (
  (select private.has_permission('jobs.view_all')) or exists (select 1 from public.jobs j where j.id = job_id));
create policy notifications_read on public.notifications for select to authenticated using (user_id = (select auth.uid()) and (select private.is_active_user()));
create policy reminder_runs_read on public.reminder_runs for select to authenticated using ((select private.has_permission('system.view')));

revoke all on public.whatsapp_log from anon, authenticated;
grant select on public.whatsapp_log to authenticated;

revoke execute on function
  public.whatsapp_context(uuid, uuid), public.log_whatsapp_message(uuid, uuid, text, text, text, boolean), public.confirm_whatsapp_sent(uuid),
  public.run_reminders_now(), public.upcoming_reminders(integer), public.mark_notifications_read(uuid[]), public.reminder_engine_status()
from public, anon;
grant execute on function
  public.whatsapp_context(uuid, uuid), public.log_whatsapp_message(uuid, uuid, text, text, text, boolean), public.confirm_whatsapp_sent(uuid),
  public.run_reminders_now(), public.upcoming_reminders(integer), public.mark_notifications_read(uuid[]), public.reminder_engine_status()
to authenticated;

revoke execute on function private.run_reminders(timestamptz, boolean), private.user_has_permission(uuid, text),
  private.reminder_kind(integer, jsonb), private.guard_whatsapp_message()
from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.whatsapp_messages, public.message_templates;
  end if;
end;
$$;
