-- =====================================================================================
-- CESS Machining Job Tracker - Phase 4: vendors, jobs, vendor assignments, attachments, Excel imports
-- * A JOB is the requirement (one combined "Part No / Part Name" field, quantity, category, Given By,
--   Created By, Assigned Staff User - three separate people fields).
-- * A JOB ASSIGNMENT is one attempt with one vendor. Cancelling and forwarding creates a NEW linked
--   assignment; the earlier one is kept unchanged (vendor journey).
-- * Original vendor commitment date is set once and can never change (revisions: Phase 5).
-- * Nothing is deleted. Status is calculated, never stored.
-- =====================================================================================

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.number_counters (
  key      text primary key,
  last_no  integer not null default 0 check (last_no >= 0)
);

create table public.vendors (
  id               uuid primary key default gen_random_uuid(),
  vendor_code      text not null unique,
  name             text not null check (length(trim(name)) between 1 and 120),
  company_name     text not null default '' check (length(company_name) <= 200),
  contact_person   text not null default '' check (length(contact_person) <= 120),
  mobile           text not null default '' check (mobile ~ '^$|^[0-9+ ()-]{6,20}$'),
  wa_country_code  text not null default '+91' check (wa_country_code ~ '^\+[0-9]{1,4}$'),
  wa_number        text not null default '' check (wa_number ~ '^$|^[0-9]{6,15}$'),
  email            text not null default '' check (email ~ '^$|^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address          text not null default '' check (length(address) <= 500),
  gst_no           text not null default '' check (gst_no ~ '^$|^[0-9]{2}[A-Z0-9]{13}$'),
  payment_terms    text not null default '' check (length(payment_terms) <= 200),
  remarks          text not null default '' check (length(remarks) <= 1000),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  version          integer not null default 1
);
create unique index vendors_name_key on public.vendors (lower(trim(name)));

create table public.vendor_categories (
  vendor_id         uuid not null references public.vendors (id) on delete cascade,
  work_category_id  uuid not null references public.work_categories (id),
  created_at        timestamptz not null default now(),
  primary key (vendor_id, work_category_id)
);

create table public.import_batches (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('jobs', 'vendors')),
  file_name      text not null,
  file_sha256    text,
  rows_total     integer not null default 0,
  rows_imported  integer not null default 0,
  rows_skipped   integer not null default 0,
  details        jsonb,
  imported_by    uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

create table public.jobs (
  id                 uuid primary key default gen_random_uuid(),
  job_no             text not null unique,
  part_label         text not null check (length(trim(part_label)) between 1 and 200),
  description        text not null default '' check (length(description) <= 2000),
  qty_sent           integer check (qty_sent is null or qty_sent between 1 and 100000000),
  category_id        uuid not null references public.work_categories (id),
  given_by_id        uuid references public.given_by_names (id),
  assigned_staff_id  uuid references public.profiles (id),
  remarks            text not null default '' check (length(remarks) <= 2000),
  source             text not null default 'app' check (source in ('app', 'excel_import')),
  import_batch_id    uuid references public.import_batches (id),
  legacy_ref         text,
  closed_at          timestamptz,
  closed_on          date,
  closed_by          uuid,
  closed_reason      text,
  archived_at        timestamptz,
  archived_by        uuid,
  archive_reason     text,
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  version            integer not null default 1,
  constraint jobs_closed_consistent check ((closed_at is null) = (closed_reason is null) and (closed_at is null) = (closed_on is null)),
  constraint jobs_archived_consistent check ((archived_at is null) = (archive_reason is null))
);
create index jobs_part_label_trgm on public.jobs using gin (part_label extensions.gin_trgm_ops);
create index jobs_created_at_idx on public.jobs (created_at desc);
create index jobs_assigned_idx on public.jobs (assigned_staff_id);
create index jobs_created_by_idx on public.jobs (created_by);
create index jobs_category_idx on public.jobs (category_id);

create table public.job_assignments (
  id                        uuid primary key default gen_random_uuid(),
  job_id                    uuid not null references public.jobs (id),
  sequence_no               integer not null check (sequence_no > 0),
  vendor_id                 uuid not null references public.vendors (id),
  dispatched_on             date not null,
  qty_sent                  integer check (qty_sent is null or qty_sent between 1 and 100000000),
  amount                    numeric(14, 2) check (amount is null or amount >= 0),
  original_commitment_date  date,
  current_commitment_date   date,
  state                     text not null default 'open' check (state in ('open', 'completed', 'cancelled')),
  completed_on              date,
  cancelled_on              date,
  cancel_reason_code        text references public.cancel_reason_codes (code),
  cancel_reason_text        text,
  cancelled_by              uuid,
  previous_assignment_id    uuid references public.job_assignments (id),
  remarks                   text not null default '' check (length(remarks) <= 2000),
  created_at                timestamptz not null default now(),
  created_by                uuid default auth.uid(),
  updated_at                timestamptz not null default now(),
  updated_by                uuid,
  version                   integer not null default 1,
  unique (job_id, sequence_no),
  constraint assignment_commitment_after_dispatch check (original_commitment_date is null or original_commitment_date >= dispatched_on),
  constraint assignment_current_after_dispatch check (current_commitment_date is null or current_commitment_date >= dispatched_on),
  constraint assignment_commitment_pair check ((original_commitment_date is null) = (current_commitment_date is null)),
  constraint assignment_cancel_complete check (
    state <> 'cancelled' or (cancelled_on is not null and cancel_reason_code is not null and length(trim(coalesce(cancel_reason_text, ''))) >= 3)),
  constraint assignment_cancel_after_dispatch check (cancelled_on is null or cancelled_on >= dispatched_on),
  constraint assignment_completed_has_date check (state <> 'completed' or completed_on is not null),
  constraint assignment_completed_after_dispatch check (completed_on is null or completed_on >= dispatched_on)
);
-- only ONE vendor can hold a job at any time
create unique index job_assignments_one_open on public.job_assignments (job_id) where state = 'open';
create index job_assignments_vendor_idx on public.job_assignments (vendor_id, dispatched_on);
create index job_assignments_job_idx on public.job_assignments (job_id, sequence_no);

create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs (id),
  assignment_id   uuid references public.job_assignments (id),
  vendor_id       uuid references public.vendors (id),
  bucket          text not null default 'job-files',
  storage_path    text not null unique,
  file_name       text not null check (length(file_name) between 1 and 255),
  extension       text not null,
  mime_type       text,
  size_bytes      bigint not null check (size_bytes > 0),
  uploaded_by     uuid not null default auth.uid(),
  uploaded_at     timestamptz not null default now(),
  archived_at     timestamptz,
  archived_by     uuid,
  archive_reason  text,
  version         integer not null default 1,
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
create index attachments_job_idx on public.attachments (job_id);

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
-- FY code for numbering: 2026-11-02 -> '2627'
create or replace function private.fy_code(p date)
returns text language sql immutable set search_path = '' as $$
  select to_char(case when extract(month from p) >= 4 then p else p - interval '1 year' end, 'YY')
      || to_char(case when extract(month from p) >= 4 then p + interval '1 year' else p end, 'YY')
$$;

create or replace function private.fy_label(p date)
returns text language sql immutable set search_path = '' as $$
  select case when p is null then null else
    extract(year from (case when extract(month from p) >= 4 then p else p - interval '1 year' end))::text || '-'
    || to_char(case when extract(month from p) >= 4 then p + interval '1 year' else p end, 'YY') end
$$;

create or replace function private.next_number(p_key text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v integer;
begin
  insert into public.number_counters (key, last_no) values (p_key, 1)
  on conflict (key) do update set last_no = public.number_counters.last_no + 1
  returning last_no into v;
  return v;
end;
$$;

create or replace function private.user_name(p_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = p_id
$$;

-- Job visibility: everything with jobs.view_all; otherwise only jobs assigned to / created by the user.
create or replace function private.can_view_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_job_id is not null and (
    private.has_permission('jobs.view_all')
    or (private.has_permission('jobs.view_assigned')
        and exists (select 1 from public.jobs j where j.id = p_job_id and (j.assigned_staff_id = auth.uid() or j.created_by = auth.uid())))
  )
$$;

create or replace function private.can_edit_job(p_job_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- 'all' | 'operational' | null
  select case
    when not private.can_view_job(p_job_id) then null
    when private.has_permission('jobs.edit') then 'all'
    when private.has_permission('jobs.edit_assigned')
         and exists (select 1 from public.jobs j where j.id = p_job_id and (j.assigned_staff_id = auth.uid() or j.created_by = auth.uid())) then 'operational'
    else null end
$$;

-- Job status (single source of truth; see docs/STATUS_RULES.md). Returns, quality and partial returns join in Phase 6.
create or replace function private.job_status(
  p_closed boolean, p_has_assignment boolean, p_open_dispatched date, p_open_commitment date, p_today date, p_due_soon_days integer
) returns text language sql immutable set search_path = '' as $$
  select case
    when p_closed then 'Completed'
    when not p_has_assignment then 'Draft'
    when p_open_dispatched is null then 'Cancelled'
    when p_open_commitment is null then 'Commitment Date Missing'
    when p_open_commitment < p_today then 'Overdue'
    when p_open_commitment = p_today then 'Due Today'
    when p_open_commitment - p_today <= p_due_soon_days then 'Due Soon'
    when p_open_dispatched >= p_today then 'Sent to Vendor'
    else 'In Progress'
  end
$$;

-- JSON payload readers with clear messages (HTTP 400)
create or replace function private.j_text(p jsonb, k text, maxlen integer, required boolean, label text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(trim(coalesce(p ->> k, '')), '');
begin
  if v is null and required then raise exception '% is required.', label using errcode = '22023'; end if;
  if v is not null and length(v) > maxlen then raise exception '% can have at most % characters.', label, maxlen using errcode = '22023'; end if;
  return v;
end;
$$;

create or replace function private.j_uuid(p jsonb, k text, required boolean, label text)
returns uuid language plpgsql immutable set search_path = '' as $$
declare v text := nullif(trim(coalesce(p ->> k, '')), '');
begin
  if v is null then
    if required then raise exception '% is required.', label using errcode = '22023'; end if;
    return null;
  end if;
  begin
    return v::uuid;
  exception when others then
    raise exception '% is not valid.', label using errcode = '22023';
  end;
end;
$$;

create or replace function private.j_date(p jsonb, k text, required boolean, label text)
returns date language plpgsql immutable set search_path = '' as $$
declare v text := nullif(trim(coalesce(p ->> k, '')), '');
begin
  if v is null then
    if required then raise exception '% is required.', label using errcode = '22023'; end if;
    return null;
  end if;
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '% must be a date (YYYY-MM-DD).', label using errcode = '22023'; end if;
  begin
    return v::date;
  exception when others then
    raise exception '% is not a valid date.', label using errcode = '22023';
  end;
end;
$$;

create or replace function private.j_int(p jsonb, k text, label text)
returns integer language plpgsql immutable set search_path = '' as $$
declare v jsonb := p -> k;
begin
  if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and trim(v #>> '{}') = '') then return null; end if;
  if (v #>> '{}') !~ '^\s*\d+\s*$' then raise exception '% must be a whole number.', label using errcode = '22023'; end if;
  if (v #>> '{}')::numeric < 1 or (v #>> '{}')::numeric > 100000000 then
    raise exception '% must be at least 1.', label using errcode = '22023';
  end if;
  return (v #>> '{}')::integer;
end;
$$;

create or replace function private.j_money(p jsonb, k text, label text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v jsonb := p -> k; n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and trim(v #>> '{}') = '') then return null; end if;
  begin
    n := replace(v #>> '{}', ',', '')::numeric;
  exception when others then
    raise exception '% must be an amount in rupees.', label using errcode = '22023';
  end;
  if n < 0 or n > 10000000000 then raise exception '% must be between 0 and 1,000 crore.', label using errcode = '22023'; end if;
  if n <> round(n, 2) then raise exception '% can have at most 2 decimal places.', label using errcode = '22023'; end if;
  return n;
end;
$$;

-- Date given to vendor: between 1-Jan-2015 and tomorrow (rule kept from the Excel tracker).
create or replace function private.check_dispatch_date(p date)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p < date '2015-01-01' or p > private.today_ist() + 1 then
    raise exception 'Date given to vendor must be between 01-Jan-2015 and tomorrow.' using errcode = '22023';
  end if;
end;
$$;

create or replace function private.require_version(p_current integer, p_expected integer, p_what text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is null or p_current <> p_expected then
    raise exception '% was changed by someone else. Reload and try again.', p_what using errcode = 'PT409', hint = 'reload';
  end if;
end;
$$;

-- Adds a vendor assignment (first send or forward). Payload: vendor_id, dispatched_on, qty_sent, amount, commitment_date, remarks
create or replace function private.add_assignment(p_job_id uuid, p jsonb, p_default_qty integer, p_previous uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vendor uuid := private.j_uuid(p, 'vendor_id', true, 'Vendor');
  v_date date := private.j_date(p, 'dispatched_on', true, 'Date given to vendor');
  v_commit date := private.j_date(p, 'commitment_date', false, 'Vendor committed delivery date');
  v_qty integer := coalesce(private.j_int(p, 'qty_sent', 'Quantity sent'), p_default_qty);
  v_amount numeric := private.j_money(p, 'amount', 'Estimated amount');
  v_seq integer;
  v_id uuid;
begin
  if not exists (select 1 from public.vendors where id = v_vendor and is_active) then
    raise exception 'Choose an active vendor.' using errcode = '22023';
  end if;
  perform private.check_dispatch_date(v_date);
  if v_commit is not null and v_commit < v_date then
    raise exception 'The committed delivery date cannot be before the date given to the vendor.' using errcode = '22023';
  end if;
  select coalesce(max(sequence_no), 0) + 1 into v_seq from public.job_assignments where job_id = p_job_id;
  insert into public.job_assignments
    (job_id, sequence_no, vendor_id, dispatched_on, qty_sent, amount, original_commitment_date, current_commitment_date,
     previous_assignment_id, remarks)
  values
    (p_job_id, v_seq, v_vendor, v_date, v_qty, v_amount, v_commit, v_commit, p_previous,
     coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Guards and audit
-- ---------------------------------------------------------------------------
create or replace function private.guard_assignment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.original_commitment_date is not null and new.original_commitment_date is distinct from old.original_commitment_date then
    raise exception 'The original commitment date (%) can never be changed; revisions are recorded separately.', old.original_commitment_date
      using errcode = '42501';
  end if;
  if old.current_commitment_date is not null and new.current_commitment_date is distinct from old.current_commitment_date
     and coalesce(current_setting('cess.commitment_revision', true), '') <> 'on' then
    raise exception 'Commitment dates are changed only through a commitment revision (kept in history).' using errcode = '42501';
  end if;
  if old.state <> 'open' then
    if new.state <> old.state or new.vendor_id <> old.vendor_id or new.dispatched_on <> old.dispatched_on
       or new.qty_sent is distinct from old.qty_sent or new.amount is distinct from old.amount
       or new.completed_on is distinct from old.completed_on or new.cancelled_on is distinct from old.cancelled_on
       or new.sequence_no <> old.sequence_no or new.job_id <> old.job_id
       or new.original_commitment_date is distinct from old.original_commitment_date
       or new.current_commitment_date is distinct from old.current_commitment_date then
      raise exception 'A closed vendor assignment cannot be changed.' using errcode = '42501';
    end if;
    if (new.cancel_reason_code is distinct from old.cancel_reason_code or new.cancel_reason_text is distinct from old.cancel_reason_text)
       and old.cancel_reason_code <> 'legacy_unclassified' then
      raise exception 'The cancellation reason is already recorded and cannot be changed.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_job()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.closed_at is not null and new.closed_at is distinct from old.closed_at then
    raise exception 'A completed job cannot be reopened.' using errcode = '42501';
  end if;
  if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
    raise exception 'An archived job cannot be restored here.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Audit trigger now also fills job_id / vendor_id so history can be filtered per job and per vendor.
create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor    uuid := auth.uid();
  v_claims   jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_old      jsonb;
  v_new      jsonb;
  v_prev     jsonb;
  v_next     jsonb;
  v_row      jsonb;
  v_entity   text := '';
  v_action   text;
  v_reason   text;
  v_name     text;
  v_role     text;
  v_source   text;
  v_job      uuid;
  v_vendor   uuid;
  i          integer;
  v_ignore   text[] := array['updated_at', 'updated_by', 'version'];
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, o.value), jsonb_object_agg(n.key, n.value)
      into v_prev, v_next
      from jsonb_each(v_new) n
      join jsonb_each(v_old) o on o.key = n.key
     where n.value is distinct from o.value
       and not (n.key = any (v_ignore));
    if v_next is null then
      return null;
    end if;
  else
    v_prev := v_old;
    v_next := v_new;
  end if;

  v_row := coalesce(v_new, v_old);
  for i in 0 .. tg_nargs - 2 loop
    v_entity := v_entity || case when i > 0 then ':' else '' end || coalesce(v_row ->> tg_argv[i], '');
  end loop;
  v_job := case when tg_table_name = 'jobs' then (v_row ->> 'id')::uuid else nullif(v_row ->> 'job_id', '')::uuid end;
  v_vendor := case when tg_table_name = 'vendors' then (v_row ->> 'id')::uuid else nullif(v_row ->> 'vendor_id', '')::uuid end;

  v_action := nullif(current_setting('cess.audit_action', true), '');
  if v_action is null then
    v_action := tg_table_name || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  end if;
  v_reason := nullif(current_setting('cess.audit_reason', true), '');

  if v_actor is not null then
    select nullif(p.full_name, ''), p.role_key into v_name, v_role from public.profiles p where p.id = v_actor;
    v_name := coalesce(v_name, (select p.email from public.profiles p where p.id = v_actor));
    v_source := 'app';
  elsif v_claims ->> 'role' = 'service_role' then
    v_source := 'service';
  else
    v_source := 'sql';
  end if;

  insert into public.activity_log
    (actor_id, actor_name, actor_role, source, action, module, entity_table, entity_id, job_id, vendor_id,
     previous_value, new_value, reason, session_id, aal)
  values
    (v_actor, v_name, v_role, v_source, v_action, coalesce(tg_argv[tg_nargs - 1], tg_table_name), tg_table_name, v_entity, v_job, v_vendor,
     v_prev, v_next, v_reason, nullif(v_claims ->> 'session_id', '')::uuid, v_claims ->> 'aal');
  return null;
end;
$$;

create trigger vendors_version before update on public.vendors for each row execute function private.bump_version();
create trigger jobs_version before update on public.jobs for each row execute function private.bump_version();
create trigger job_assignments_version before update on public.job_assignments for each row execute function private.bump_version();
create trigger attachments_version before update on public.attachments for each row execute function private.bump_version();

create trigger job_assignments_guard before update on public.job_assignments for each row execute function private.guard_assignment();
create trigger jobs_guard before update on public.jobs for each row execute function private.guard_job();

create trigger vendors_no_delete before delete on public.vendors for each row execute function private.forbid_delete();
create trigger jobs_no_delete before delete on public.jobs for each row execute function private.forbid_delete();
create trigger job_assignments_no_delete before delete on public.job_assignments for each row execute function private.forbid_delete();
create trigger attachments_no_delete before delete on public.attachments for each row execute function private.forbid_delete();
create trigger import_batches_no_delete before delete on public.import_batches for each row execute function private.forbid_delete();

create trigger vendors_audit after insert or update or delete on public.vendors
  for each row execute function private.audit_row('id', 'vendors');
create trigger vendor_categories_audit after insert or update or delete on public.vendor_categories
  for each row execute function private.audit_row('vendor_id', 'work_category_id', 'vendors');
create trigger jobs_audit after insert or update or delete on public.jobs
  for each row execute function private.audit_row('id', 'jobs');
create trigger job_assignments_audit after insert or update or delete on public.job_assignments
  for each row execute function private.audit_row('id', 'jobs');
create trigger attachments_audit after insert or update or delete on public.attachments
  for each row execute function private.audit_row('id', 'attachments');

-- ---------------------------------------------------------------------------
-- 4. Seed: permission for Excel import, legacy cancellation reason
-- ---------------------------------------------------------------------------
select private.set_audit_context('system.seeded', 'Phase 4 reference data (migration 20261103000100)');
insert into public.permissions (key, module, label, description, admin_only, sort_order) values
  ('data.import', 'admin', 'Import data from Excel', 'Jobs and vendors from the Excel tracker or the import templates.', false, 83);
insert into public.cancel_reason_codes (code, label, vendor_related, vendor_subtype, is_active, is_system, sort_order) values
  ('legacy_unclassified', 'Imported from Excel - reason not recorded (please classify)', false, null, false, true, 99);
select private.set_audit_context(null, null);

-- ---------------------------------------------------------------------------
-- 5. Job register (status and day counts calculated on every read, in Indian time)
-- ---------------------------------------------------------------------------
create view public.job_register with (security_invoker = true) as
select
  j.id, j.job_no, j.part_label, j.description, j.qty_sent, j.remarks, j.source, j.version,
  j.category_id, c.name as category_name,
  j.given_by_id, g.name as given_by_name,
  j.assigned_staff_id, private.user_name(j.assigned_staff_id) as assigned_staff_name,
  j.created_by, private.user_name(j.created_by) as created_by_name, j.created_at,
  j.closed_at, j.closed_on, j.closed_reason, j.archived_at,
  cur.id as assignment_id, cur.sequence_no, cur.version as assignment_version, cur.state as assignment_state,
  cur.vendor_id, v.name as vendor_name,
  cur.dispatched_on as date_given, cur.qty_sent as assignment_qty, cur.amount,
  cur.original_commitment_date, cur.current_commitment_date,
  coalesce(j.closed_on, cur.completed_on) as return_date,
  cur.cancelled_on,
  (select count(*)::int from public.job_assignments x where x.job_id = j.id) as assignment_count,
  st.status,
  case when cur.id is null then null
       else coalesce(j.closed_on, case cur.state when 'open' then cfg.today when 'completed' then cur.completed_on else cur.cancelled_on end) - cur.dispatched_on
  end as days_since_given,
  case when cur.state = 'open' and j.closed_at is null and cur.current_commitment_date is not null
       then cur.current_commitment_date - cfg.today end as remaining_days,
  case when cur.original_commitment_date is not null and cur.state <> 'cancelled'
       then greatest(0, coalesce(j.closed_on, cur.completed_on, cfg.today) - cur.original_commitment_date) end as delay_days,
  case when cur.current_commitment_date is not null and cur.state <> 'cancelled'
       then greatest(0, coalesce(j.closed_on, cur.completed_on, cfg.today) - cur.current_commitment_date) end as delay_days_current,
  (cur.state = 'open' and j.closed_at is null and cfg.today - cur.dispatched_on > cfg.long_days) as long_pending,
  private.fy_label(cur.dispatched_on) as financial_year
from public.jobs j
join public.work_categories c on c.id = j.category_id
left join public.given_by_names g on g.id = j.given_by_id
left join lateral (
  select a.* from public.job_assignments a where a.job_id = j.id
  order by (a.state = 'open') desc, a.sequence_no desc limit 1
) cur on true
left join public.vendors v on v.id = cur.vendor_id
cross join lateral (
  select private.today_ist() as today,
         private.setting_int('jobs', 'due_soon_days', 3) as due_soon,
         private.setting_int('jobs', 'long_pending_days', 10) as long_days
) cfg
cross join lateral (
  select private.job_status(j.closed_at is not null, cur.id is not null,
                            case when cur.state = 'open' then cur.dispatched_on end,
                            case when cur.state = 'open' then cur.current_commitment_date end,
                            cfg.today, cfg.due_soon) as status
) st;
