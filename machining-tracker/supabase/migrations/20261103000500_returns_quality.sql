-- =====================================================================================
-- Phase 6 (part 1): material returns, quality inspection, job completion, reopening.
-- Rules: docs/RETURNS_AND_PAYMENTS.md. Quantities per vendor assignment:
--   with vendor        = quantity sent - returned + sent back for rework
--   awaiting inspection = returned - (accepted + rejected + rework)
-- A job completes automatically only when nothing is with the vendor and nothing awaits inspection
-- (every piece accepted or rejected). Otherwise an authorised user closes it with a reason.
-- Returns and inspections are never edited or deleted: a mistake is voided with a reason and re-entered.
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.material_returns (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null references public.job_assignments (id),
  job_id         uuid not null references public.jobs (id),
  vendor_id      uuid not null references public.vendors (id),
  return_no      integer not null check (return_no > 0),
  returned_on    date not null,
  qty_received   integer not null check (qty_received between 1 and 100000000),
  challan_no     text not null default '' check (length(challan_no) <= 100),
  remarks        text not null default '' check (length(remarks) <= 2000),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  voided_at      timestamptz,
  voided_by      uuid,
  void_reason    text,
  unique (assignment_id, return_no),
  constraint material_return_void check ((voided_at is null) = (void_reason is null))
);
create index material_returns_job_idx on public.material_returns (job_id);
create index material_returns_assignment_idx on public.material_returns (assignment_id);

create table public.quality_inspections (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references public.material_returns (id),
  assignment_id   uuid not null references public.job_assignments (id),
  job_id          uuid not null references public.jobs (id),
  vendor_id       uuid not null references public.vendors (id),
  inspected_on    date not null,
  qty_accepted    integer not null default 0 check (qty_accepted >= 0),
  qty_rejected    integer not null default 0 check (qty_rejected >= 0),
  qty_rework      integer not null default 0 check (qty_rework >= 0),
  inspector_name  text not null check (length(trim(inspector_name)) between 1 and 120),
  remarks         text not null default '' check (length(remarks) <= 2000),
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,
  constraint quality_inspection_some check (qty_accepted + qty_rejected + qty_rework > 0),
  constraint quality_inspection_void check ((voided_at is null) = (void_reason is null))
);
create index quality_inspections_return_idx on public.quality_inspections (return_id);
create index quality_inspections_assignment_idx on public.quality_inspections (assignment_id);
create index quality_inspections_job_idx on public.quality_inspections (job_id);

-- Only the void fields may be filled in, once; nothing else ever changes and nothing is deleted.
create or replace function private.guard_void_only()
returns trigger language plpgsql set search_path = '' as $$
declare v_keep text[] := array['voided_at', 'voided_by', 'void_reason'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Deleting from % is not allowed: void the entry with a reason instead.', tg_table_name using errcode = '42501';
  end if;
  if old.voided_at is not null then
    raise exception 'This entry is already voided and cannot change.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_keep) is distinct from (to_jsonb(old) - v_keep) then
    raise exception 'Recorded returns and inspections cannot be edited: void the entry with a reason and record it again.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger material_returns_guard before update or delete on public.material_returns
  for each row execute function private.guard_void_only();
create trigger quality_inspections_guard before update or delete on public.quality_inspections
  for each row execute function private.guard_void_only();
create trigger material_returns_no_truncate before truncate on public.material_returns
  for each statement execute function private.forbid_change();
create trigger quality_inspections_no_truncate before truncate on public.quality_inspections
  for each statement execute function private.forbid_change();
create trigger material_returns_audit after insert or update on public.material_returns
  for each row execute function private.audit_row('id', 'jobs');
create trigger quality_inspections_audit after insert or update on public.quality_inspections
  for each row execute function private.audit_row('id', 'jobs');

-- ---------------------------------------------------------------------------
-- 2. Quantities (single source of truth for screens, status and completion)
-- ---------------------------------------------------------------------------
create or replace function private.assignment_quantities(p_assignment_id uuid)
returns table (
  qty_sent integer, received integer, accepted integer, rejected integer, rework integer,
  inspected integer, awaiting integer, with_vendor integer, last_returned_on date, returns integer
) language sql stable security definer set search_path = '' as $$
  with r as (
    select coalesce(sum(m.qty_received), 0)::int as received, max(m.returned_on) as last_on, count(*)::int as n
      from public.material_returns m where m.assignment_id = p_assignment_id and m.voided_at is null
  ), i as (
    select coalesce(sum(q.qty_accepted), 0)::int as acc, coalesce(sum(q.qty_rejected), 0)::int as rej,
           coalesce(sum(q.qty_rework), 0)::int as rwk
      from public.quality_inspections q
      join public.material_returns m on m.id = q.return_id and m.voided_at is null
     where q.assignment_id = p_assignment_id and q.voided_at is null
  )
  select a.qty_sent, r.received, i.acc, i.rej, i.rwk, i.acc + i.rej + i.rwk,
         r.received - (i.acc + i.rej + i.rwk),
         case when a.qty_sent is not null then a.qty_sent - r.received + i.rwk end,
         r.last_on, r.n
    from public.job_assignments a, r, i
   where a.id = p_assignment_id
$$;

-- Readable per-assignment quantities for screens (visibility follows the jobs the user can see).
create view public.assignment_quantities with (security_invoker = true) as
select a.id as assignment_id, a.job_id, a.vendor_id, a.state, q.qty_sent, q.received, q.accepted, q.rejected, q.rework,
       q.inspected, q.awaiting, q.with_vendor, q.last_returned_on, q.returns,
       case when q.inspected > 0 then round(100.0 * q.accepted / q.inspected, 1) end as acceptance_pct,
       case when q.inspected > 0 then round(100.0 * q.rejected / q.inspected, 1) end as rejection_pct,
       case when q.inspected > 0 then round(100.0 * q.rework / q.inspected, 1) end as rework_pct
  from public.job_assignments a
 cross join lateral private.assignment_quantities(a.id) q;

-- Status of one inspection / one return lot (shown on screens; never stored).
create or replace function private.quality_status(p_accepted integer, p_rejected integer, p_rework integer, p_uninspected integer)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_uninspected > 0 then 'Inspection Pending'
    when p_accepted > 0 and p_rejected = 0 and p_rework = 0 then 'Accepted'
    when p_accepted > 0 then 'Partially Accepted'
    when p_rework > 0 then 'Rework Required'
    when p_rejected > 0 then 'Rejected'
    else 'Inspection Pending' end
$$;

create view public.material_return_lots with (security_invoker = true) as
select m.id, m.assignment_id, m.job_id, m.vendor_id, v.name as vendor_name, m.return_no, m.returned_on, m.qty_received,
       m.challan_no, m.remarks, m.created_at, m.created_by, private.user_name(m.created_by) as recorded_by_name,
       m.voided_at, m.void_reason, private.user_name(m.voided_by) as voided_by_name,
       coalesce(i.acc, 0) as qty_accepted, coalesce(i.rej, 0) as qty_rejected, coalesce(i.rwk, 0) as qty_rework,
       m.qty_received - coalesce(i.acc + i.rej + i.rwk, 0) as qty_uninspected,
       case when m.voided_at is not null then 'Voided'
            else private.quality_status(coalesce(i.acc, 0), coalesce(i.rej, 0), coalesce(i.rwk, 0),
                                        m.qty_received - coalesce(i.acc + i.rej + i.rwk, 0)) end as quality_status
  from public.material_returns m
  join public.vendors v on v.id = m.vendor_id
  left join lateral (
    select sum(q.qty_accepted)::int as acc, sum(q.qty_rejected)::int as rej, sum(q.qty_rework)::int as rwk
      from public.quality_inspections q where q.return_id = m.id and q.voided_at is null
  ) i on true;

create view public.quality_inspection_log with (security_invoker = true) as
select q.id, q.return_id, q.assignment_id, q.job_id, q.vendor_id, q.inspected_on, q.qty_accepted, q.qty_rejected, q.qty_rework,
       q.qty_accepted + q.qty_rejected + q.qty_rework as qty_inspected,
       private.quality_status(q.qty_accepted, q.qty_rejected, q.qty_rework, 0) as quality_status,
       q.inspector_name, q.remarks, q.created_at, private.user_name(q.created_by) as recorded_by_name,
       q.voided_at, q.void_reason, private.user_name(q.voided_by) as voided_by_name
  from public.quality_inspections q;

-- ---------------------------------------------------------------------------
-- 3. Guards: reopening and billing need an explicit flag set by the checked functions
-- ---------------------------------------------------------------------------
create or replace function private.guard_job()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.closed_at is not null and new.closed_at is distinct from old.closed_at
     and coalesce(current_setting('cess.reopen', true), '') <> 'on' then
    raise exception 'A completed job cannot be reopened here. Use "Reopen job" (a reason is recorded).' using errcode = '42501';
  end if;
  if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
    raise exception 'An archived job cannot be restored here.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.guard_assignment()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_changed text[];
  v_received integer;
  v_rework integer;
begin
  if old.original_commitment_date is not null and new.original_commitment_date is distinct from old.original_commitment_date then
    raise exception 'The original commitment date (%) can never be changed; revisions are recorded separately.', old.original_commitment_date
      using errcode = '42501';
  end if;
  if old.current_commitment_date is not null and new.current_commitment_date is distinct from old.current_commitment_date
     and coalesce(current_setting('cess.commitment_revision', true), '') <> 'on' then
    raise exception 'Commitment dates are changed only through a commitment revision (kept in history).' using errcode = '42501';
  end if;

  select coalesce(array_agg(n.key), '{}') into v_changed
    from jsonb_each(to_jsonb(new)) n
   where n.value is distinct from (to_jsonb(old) -> n.key)
     and n.key not in ('updated_at', 'updated_by', 'version', 'remarks');

  if old.state <> 'open' and cardinality(v_changed) > 0 then
    if v_changed <@ array['cancel_reason_code', 'cancel_reason_text'] then
      if old.cancel_reason_code <> 'legacy_unclassified' then
        raise exception 'The cancellation reason is already recorded and cannot be changed.' using errcode = '42501';
      end if;
    elsif v_changed <@ array['amount', 'invoice_no', 'invoice_date'] and coalesce(current_setting('cess.billing', true), '') = 'on' then
      null; -- vendor invoice recorded after the work (Admin, through record_vendor_invoice)
    elsif v_changed <@ array['state', 'completed_on'] and old.state = 'completed' and new.state = 'open'
          and coalesce(current_setting('cess.reopen', true), '') = 'on' then
      null; -- reopened with a reason (reopen_job)
    else
      raise exception 'A closed vendor assignment cannot be changed.' using errcode = '42501';
    end if;
  end if;

  -- the quantity sent can never fall below what is already back (net of pieces sent back for rework)
  if new.qty_sent is distinct from old.qty_sent and new.qty_sent is not null then
    select q.received, q.rework into v_received, v_rework from private.assignment_quantities(old.id) q;
    if new.qty_sent < v_received - v_rework then
      raise exception 'The quantity sent cannot be less than the % pieces already returned.', v_received - v_rework using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Completion
-- ---------------------------------------------------------------------------
-- Completes the assignment and the job when every piece sent is back and inspected (accepted or rejected).
create or replace function private.try_complete_assignment(p_assignment_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare q record; a public.job_assignments;
begin
  select * into a from public.job_assignments where id = p_assignment_id;
  if a.state <> 'open' then
    return false;
  end if;
  select * into q from private.assignment_quantities(p_assignment_id);
  if q.qty_sent is null or q.with_vendor <> 0 or q.awaiting <> 0 or q.received = 0 then
    return false;
  end if;
  perform private.set_audit_context('job.vendor_work_completed', null);
  update public.job_assignments set state = 'completed', completed_on = q.last_returned_on where id = p_assignment_id;
  perform private.set_audit_context('job.completed', format('All %s pieces returned and inspected: %s accepted, %s rejected', q.qty_sent, q.accepted, q.rejected));
  update public.jobs set closed_at = now(), closed_on = q.last_returned_on, closed_by = auth.uid(),
         closed_reason = format('All %s pieces returned and inspected: %s accepted, %s rejected.', q.qty_sent, q.accepted, q.rejected)
   where id = a.job_id;
  perform private.set_audit_context(null, null);
  return true;
end;
$$;

create or replace function private.open_assignment_for_update(p_assignment_id uuid)
returns public.job_assignments language plpgsql volatile security definer set search_path = '' as $$
declare a public.job_assignments; j public.jobs;
begin
  select * into a from public.job_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'Vendor assignment not found.' using errcode = 'P0002';
  end if;
  if not private.can_view_job(a.job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  select * into j from public.jobs where id = a.job_id;
  if a.state <> 'open' or j.closed_at is not null or j.archived_at is not null then
    raise exception 'This vendor assignment is not open (completed, cancelled or archived). Reopen the job first if a correction is needed.'
      using errcode = '22023';
  end if;
  return a;
end;
$$;

create or replace function private.add_inspection(p_return public.material_returns, p jsonb)
returns public.quality_inspections language plpgsql volatile security definer set search_path = '' as $$
declare
  v_date date := private.j_date(p, 'inspected_on', true, 'Inspection date');
  v_acc integer := coalesce(private.j_int0(p, 'qty_accepted', 'Accepted quantity'), 0);
  v_rej integer := coalesce(private.j_int0(p, 'qty_rejected', 'Rejected quantity'), 0);
  v_rwk integer := coalesce(private.j_int0(p, 'qty_rework', 'Rework quantity'), 0);
  v_left integer;
  v_row public.quality_inspections;
begin
  perform private.require_permission('quality.manage');
  if p_return.voided_at is not null then
    raise exception 'This return was voided.' using errcode = '22023';
  end if;
  if v_date < p_return.returned_on or v_date > private.today_ist() then
    raise exception 'Inspection date must be between the return date and today.' using errcode = '22023';
  end if;
  if v_acc + v_rej + v_rwk = 0 then
    raise exception 'Enter the accepted, rejected or rework quantity.' using errcode = '22023';
  end if;
  select l.qty_uninspected into v_left from public.material_return_lots l where l.id = p_return.id;
  if v_acc + v_rej + v_rwk > v_left then
    raise exception 'Only % pieces of this return are still to be inspected.', v_left using errcode = '22023';
  end if;
  perform private.set_audit_context('job.inspected', null);
  insert into public.quality_inspections
    (return_id, assignment_id, job_id, vendor_id, inspected_on, qty_accepted, qty_rejected, qty_rework, inspector_name, remarks)
  values
    (p_return.id, p_return.assignment_id, p_return.job_id, p_return.vendor_id, v_date, v_acc, v_rej, v_rwk,
     coalesce(private.j_text(p, 'inspector_name', 120, false, 'Inspected by'), private.user_name(auth.uid()), 'Unknown'),
     coalesce(private.j_text(p, 'remarks', 2000, false, 'Inspection remarks'), ''))
  returning * into v_row;
  perform private.set_audit_context(null, null);
  return v_row;
end;
$$;

-- whole number >= 0 (j_int accepts only >= 1)
create or replace function private.j_int0(p jsonb, k text, label text)
returns integer language plpgsql immutable set search_path = '' as $$
declare v jsonb := p -> k;
begin
  if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and trim(v #>> '{}') = '') then return null; end if;
  if (v #>> '{}') !~ '^\s*\d+\s*$' or (v #>> '{}')::numeric > 100000000 then
    raise exception '% must be a whole number (0 or more).', label using errcode = '22023';
  end if;
  return (v #>> '{}')::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Functions for screens
-- ---------------------------------------------------------------------------
-- Payload: returned_on, qty_received, challan_no, remarks, inspection: { inspected_on, qty_accepted, qty_rejected, qty_rework, inspector_name, remarks }
create or replace function public.record_return(p_assignment_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  q record;
  v_date date := private.j_date(p, 'returned_on', true, 'Return date');
  v_qty integer := private.j_int(p, 'qty_received', 'Quantity received');
  v_no integer;
  v_ret public.material_returns;
  v_insp public.quality_inspections;
  v_done boolean;
begin
  perform private.require_permission('returns.record');
  a := private.open_assignment_for_update(p_assignment_id);
  if v_qty is null then
    raise exception 'Enter the quantity received.' using errcode = '22023';
  end if;
  if v_date < a.dispatched_on or v_date > private.today_ist() then
    raise exception 'Return date must be between the date given to the vendor and today.' using errcode = '22023';
  end if;
  select * into q from private.assignment_quantities(a.id);
  if q.qty_sent is not null and v_qty > q.with_vendor then
    raise exception 'Only % pieces are with the vendor (sent %, returned %, sent back for rework %).', q.with_vendor, q.qty_sent, q.received, q.rework
      using errcode = '22023';
  end if;
  select coalesce(max(return_no), 0) + 1 into v_no from public.material_returns where assignment_id = a.id;
  perform private.set_audit_context('job.material_returned', null);
  insert into public.material_returns (assignment_id, job_id, vendor_id, return_no, returned_on, qty_received, challan_no, remarks)
  values (a.id, a.job_id, a.vendor_id, v_no, v_date, v_qty,
          coalesce(private.j_text(p, 'challan_no', 100, false, 'Delivery challan number'), ''),
          coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), ''))
  returning * into v_ret;
  perform private.set_audit_context(null, null);
  if jsonb_typeof(p -> 'inspection') = 'object' then
    v_insp := private.add_inspection(v_ret, p -> 'inspection');
  end if;
  v_done := private.try_complete_assignment(a.id);
  return jsonb_build_object('return', to_jsonb(v_ret), 'inspection', to_jsonb(v_insp), 'completed', v_done,
                            'quantities', (select to_jsonb(x) from private.assignment_quantities(a.id) x));
end;
$$;

create or replace function public.record_inspection(p_return_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.material_returns; v_insp public.quality_inspections; v_done boolean;
begin
  perform private.require_permission('quality.manage');
  select * into r from public.material_returns where id = p_return_id;
  if not found then
    raise exception 'Return not found.' using errcode = 'P0002';
  end if;
  perform private.open_assignment_for_update(r.assignment_id);
  v_insp := private.add_inspection(r, p);
  v_done := private.try_complete_assignment(r.assignment_id);
  return jsonb_build_object('inspection', to_jsonb(v_insp), 'completed', v_done,
                            'quantities', (select to_jsonb(x) from private.assignment_quantities(r.assignment_id) x));
end;
$$;

create or replace function public.void_return(p_return_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.material_returns; v_reason text;
begin
  perform private.require_permission('returns.record');
  v_reason := private.require_reason(p_reason);
  select * into r from public.material_returns where id = p_return_id;
  if not found then
    raise exception 'Return not found.' using errcode = 'P0002';
  end if;
  perform private.open_assignment_for_update(r.assignment_id);
  if r.voided_at is not null then
    raise exception 'This return is already voided.' using errcode = '22023';
  end if;
  if exists (select 1 from public.quality_inspections q where q.return_id = r.id and q.voided_at is null) then
    raise exception 'Void the inspections of this return first.' using errcode = '22023';
  end if;
  perform private.set_audit_context('job.return_voided', v_reason);
  update public.material_returns set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = r.id returning * into r;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

create or replace function public.void_inspection(p_inspection_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare i public.quality_inspections; v_reason text;
begin
  perform private.require_permission('quality.manage');
  v_reason := private.require_reason(p_reason);
  select * into i from public.quality_inspections where id = p_inspection_id;
  if not found then
    raise exception 'Inspection not found.' using errcode = 'P0002';
  end if;
  perform private.open_assignment_for_update(i.assignment_id);
  if i.voided_at is not null then
    raise exception 'This inspection is already voided.' using errcode = '22023';
  end if;
  perform private.set_audit_context('job.inspection_voided', v_reason);
  update public.quality_inspections set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = i.id returning * into i;
  perform private.set_audit_context(null, null);
  return to_jsonb(i);
end;
$$;

-- Close a job that will not complete by itself (rejections accepted as final, remaining pieces not needed, quantity unknown ...).
create or replace function public.close_job(p_job_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare j public.jobs; a public.job_assignments; q record; v_reason text;
begin
  perform private.require_permission('jobs.edit');
  v_reason := private.require_reason(p_reason);
  select * into j from public.jobs where id = p_job_id for update;
  if not found or not private.can_view_job(p_job_id) then
    raise exception 'Job not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(j.version, p_expected_version, 'This job');
  select * into a from public.job_assignments where job_id = j.id and state = 'open';
  if not found or j.closed_at is not null or j.archived_at is not null then
    raise exception 'Only a job that is with a vendor can be closed.' using errcode = '22023';
  end if;
  a := private.open_assignment_for_update(a.id);
  select * into q from private.assignment_quantities(a.id);
  if q.received = 0 then
    raise exception 'Nothing has been returned yet. Record the return, or cancel the vendor assignment instead.' using errcode = '22023';
  end if;
  if q.awaiting > 0 then
    raise exception 'Inspect the % returned pieces that are still awaiting inspection first.', q.awaiting using errcode = '22023';
  end if;
  perform private.set_audit_context('job.vendor_work_completed', null);
  update public.job_assignments set state = 'completed', completed_on = q.last_returned_on where id = a.id;
  perform private.set_audit_context('job.closed', v_reason);
  update public.jobs set closed_at = now(), closed_on = q.last_returned_on, closed_by = auth.uid(), closed_reason = v_reason
   where id = j.id returning * into j;
  perform private.set_audit_context(null, null);
  return to_jsonb(j);
end;
$$;

create or replace function public.reopen_job(p_job_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare j public.jobs; a public.job_assignments; v_reason text;
begin
  perform private.require_permission('jobs.edit');
  v_reason := private.require_reason(p_reason);
  select * into j from public.jobs where id = p_job_id for update;
  if not found or not private.can_view_job(p_job_id) then
    raise exception 'Job not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(j.version, p_expected_version, 'This job');
  if j.closed_at is null then
    raise exception 'This job is not completed.' using errcode = '22023';
  end if;
  if j.archived_at is not null then
    raise exception 'An archived job cannot be reopened.' using errcode = '22023';
  end if;
  select * into a from public.job_assignments where job_id = j.id order by sequence_no desc limit 1 for update;
  if a.state <> 'completed' then
    raise exception 'The last vendor assignment of this job is not a completed one.' using errcode = '22023';
  end if;
  perform set_config('cess.reopen', 'on', true);
  perform private.set_audit_context('job.vendor_work_reopened', null);
  update public.job_assignments set state = 'open', completed_on = null where id = a.id;
  perform private.set_audit_context('job.reopened', v_reason);
  update public.jobs set closed_at = null, closed_on = null, closed_by = null, closed_reason = null where id = j.id returning * into j;
  perform set_config('cess.reopen', '', true);
  perform private.set_audit_context(null, null);
  return to_jsonb(j);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Status with returns and inspection (see docs/STATUS_RULES.md)
-- ---------------------------------------------------------------------------
create or replace function private.job_status_full(
  p_closed boolean, p_has_assignment boolean, p_open_dispatched date, p_open_commitment date, p_today date, p_due_soon_days integer,
  p_received integer, p_awaiting integer, p_with_vendor integer
) returns text language sql immutable set search_path = '' as $$
  select case
    when p_closed then 'Completed'
    when not p_has_assignment then 'Draft'
    when p_open_dispatched is null then 'Cancelled'
    when coalesce(p_received, 0) = 0 then private.job_status(false, true, p_open_dispatched, p_open_commitment, p_today, p_due_soon_days)
    -- something is back
    when coalesce(p_with_vendor, 1) > 0 and p_open_commitment < p_today then 'Overdue'
    when coalesce(p_with_vendor, 1) > 0 and p_open_commitment = p_today then 'Due Today'
    when p_awaiting > 0 then 'Quality Inspection Pending'
    else 'Partially Returned'
  end
$$;

-- ---------------------------------------------------------------------------
-- 7. Job register with quantities and the new statuses (columns appended)
-- ---------------------------------------------------------------------------
create or replace view public.job_register with (security_invoker = true) as
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
  private.fy_label(cur.dispatched_on) as financial_year,
  (select count(*)::int from public.commitment_revisions r where r.assignment_id = cur.id) as revision_count,
  qty.received as qty_received, qty.accepted as qty_accepted, qty.rejected as qty_rejected, qty.rework as qty_rework,
  qty.awaiting as qty_awaiting_inspection, qty.with_vendor as qty_with_vendor
from public.jobs j
join public.work_categories c on c.id = j.category_id
left join public.given_by_names g on g.id = j.given_by_id
left join lateral (
  select a.* from public.job_assignments a where a.job_id = j.id
  order by (a.state = 'open') desc, a.sequence_no desc limit 1
) cur on true
left join public.vendors v on v.id = cur.vendor_id
left join lateral private.assignment_quantities(cur.id) qty on true
cross join lateral (
  select private.today_ist() as today,
         private.setting_int('jobs', 'due_soon_days', 3) as due_soon,
         private.setting_int('jobs', 'long_pending_days', 10) as long_days
) cfg
cross join lateral (
  select private.job_status_full(j.closed_at is not null, cur.id is not null,
                                 case when cur.state = 'open' then cur.dispatched_on end,
                                 case when cur.state = 'open' then cur.current_commitment_date end,
                                 cfg.today, cfg.due_soon,
                                 case when cur.state = 'open' then qty.received end,
                                 case when cur.state = 'open' then qty.awaiting end,
                                 case when cur.state = 'open' then qty.with_vendor end) as status
) st;

-- ---------------------------------------------------------------------------
-- 8. Reliability: the quality factor now comes from inspections (approved formula: accepted / inspected pieces)
-- ---------------------------------------------------------------------------
drop function private.reliability_assignments(date, date, uuid);
create or replace function private.reliability_assignments(p_from date, p_to date, p_category uuid)
returns table (
  assignment_id uuid, job_id uuid, job_no text, part_label text, category_id uuid, category_name text,
  vendor_id uuid, vendor_name text, sequence_no integer, dispatched_on date,
  original_commitment_date date, current_commitment_date date, completed_on date, cancelled_on date,
  cancel_reason_code text, cancel_reason_label text, bucket text,
  days_taken integer, late_days integer, late_days_current integer,
  revisions integer, vendor_revisions integer, overdue_now boolean, category_median_days numeric,
  qty_inspected integer, qty_accepted integer, qty_rejected integer, qty_rework integer
) language sql stable security definer set search_path = '' as $$
  with base as (
    select a.id, a.job_id, j.job_no, j.part_label, j.category_id, c.name as category_name,
           a.vendor_id, v.name as vendor_name, a.sequence_no, a.dispatched_on,
           a.original_commitment_date, a.current_commitment_date, a.completed_on, a.cancelled_on,
           a.cancel_reason_code, r.label as cancel_reason_label,
           case
             when a.state = 'completed' then 'completed'
             when a.state = 'cancelled' and r.vendor_related then 'vendor_cancelled'
             when a.state = 'cancelled' and a.cancel_reason_code = 'legacy_unclassified' then 'unclassified_cancelled'
             when a.state = 'cancelled' then 'other_cancelled'
             when j.closed_at is not null then 'closed_no_return'
             else 'open'
           end as bucket,
           (select count(*)::int from public.commitment_revisions cr where cr.assignment_id = a.id) as revisions,
           (select count(*)::int from public.commitment_revisions cr where cr.assignment_id = a.id and cr.requested_by = 'vendor') as vendor_revisions
      from public.job_assignments a
      join public.jobs j on j.id = a.job_id and j.archived_at is null
      join public.work_categories c on c.id = j.category_id
      join public.vendors v on v.id = a.vendor_id
      left join public.cancel_reason_codes r on r.code = a.cancel_reason_code
     where (p_from is null or a.dispatched_on >= p_from)
       and (p_to is null or a.dispatched_on <= p_to)
       and (p_category is null or j.category_id = p_category)
  ),
  medians as (
    -- the "usual" completion time of a category: needs at least 3 completed jobs from at least 2 vendors
    select b.category_id,
           percentile_cont(0.5) within group (order by greatest(b.completed_on - b.dispatched_on, 1))::numeric as median_days
      from base b
     where b.bucket = 'completed'
     group by b.category_id
    having count(*) >= 3 and count(distinct b.vendor_id) >= 2
  )
  select b.id, b.job_id, b.job_no, b.part_label, b.category_id, b.category_name,
         b.vendor_id, b.vendor_name, b.sequence_no, b.dispatched_on,
         b.original_commitment_date, b.current_commitment_date, b.completed_on, b.cancelled_on,
         b.cancel_reason_code, b.cancel_reason_label, b.bucket,
         case when b.bucket = 'completed' then b.completed_on - b.dispatched_on end,
         case when b.bucket = 'completed' and b.original_commitment_date is not null
              then greatest(0, b.completed_on - b.original_commitment_date) end,
         case when b.bucket = 'completed' and b.current_commitment_date is not null
              then greatest(0, b.completed_on - b.current_commitment_date) end,
         b.revisions, b.vendor_revisions,
         (b.bucket = 'open' and b.current_commitment_date < private.today_ist()),
         m.median_days,
         coalesce(qi.acc + qi.rej + qi.rwk, 0), coalesce(qi.acc, 0), coalesce(qi.rej, 0), coalesce(qi.rwk, 0)
    from base b
    left join medians m on m.category_id = b.category_id
    left join lateral (
      select sum(q.qty_accepted)::int as acc, sum(q.qty_rejected)::int as rej, sum(q.qty_rework)::int as rwk
        from public.quality_inspections q
        join public.material_returns mr on mr.id = q.return_id and mr.voided_at is null
       where q.assignment_id = b.id and q.voided_at is null
    ) qi on true
$$;

-- Factor scores, renormalised weighted score and supporting numbers per vendor (or per vendor + category).
create or replace function private.reliability_scores(p_from date, p_to date, p_category uuid, p_vendor uuid, p_by_category boolean)
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s jsonb := coalesce((select value from public.app_settings where key = 'reliability'), '{}'::jsonb);
  w jsonb := coalesce(s -> 'weights', '{}'::jsonb);
  v_min_jobs integer := coalesce((s ->> 'min_eligible_jobs')::integer, 5);
  v_min_factors integer := coalesce((s ->> 'min_factors')::integer, 3);
  v_cap numeric := coalesce((s ->> 'delay_cap_days')::numeric, 14);
  v_rev_cap numeric := coalesce((s ->> 'stability_revisions_cap')::numeric, 2);
  v_excellent numeric := coalesce((s -> 'labels' ->> 'excellent')::numeric, 85);
  v_good numeric := coalesce((s -> 'labels' ->> 'good')::numeric, 70);
  v_average numeric := coalesce((s -> 'labels' ->> 'average')::numeric, 50);
begin
  return query
  with a as (
    select * from private.reliability_assignments(p_from, p_to, p_category) x
     where p_vendor is null or x.vendor_id = p_vendor
  ),
  g as (
    select a.vendor_id,
           min(a.vendor_name) as vendor_name,
           case when p_by_category then a.category_id end as cat_id,
           case when p_by_category then min(a.category_name) end as cat_name,
           count(*) as total,
           count(*) filter (where a.bucket = 'completed') as completed,
           count(*) filter (where a.bucket = 'vendor_cancelled') as vendor_cancelled,
           count(*) filter (where a.bucket = 'other_cancelled') as other_cancelled,
           count(*) filter (where a.bucket = 'unclassified_cancelled') as unclassified_cancelled,
           count(*) filter (where a.bucket = 'open') as open_jobs,
           count(*) filter (where a.bucket = 'open' and a.current_commitment_date is not null) as open_committed,
           count(*) filter (where a.overdue_now) as overdue_now,
           count(*) filter (where a.bucket = 'closed_no_return') as closed_no_return,
           count(*) filter (where a.bucket = 'completed' and a.original_commitment_date is null) as completed_no_commitment,
           count(*) filter (where a.bucket = 'completed' and a.original_commitment_date is not null) as committed_n,
           count(*) filter (where a.bucket = 'completed' and a.late_days = 0) as on_time_n,
           count(*) filter (where a.bucket = 'completed' and a.late_days > 0) as late_n,
           avg(a.late_days) filter (where a.bucket = 'completed' and a.late_days > 0) as avg_late,
           coalesce(sum(a.late_days) filter (where a.bucket = 'completed'), 0) as total_late,
           avg(a.late_days_current) filter (where a.bucket = 'completed' and a.late_days_current > 0) as avg_late_current,
           count(*) filter (where a.bucket = 'completed' and a.late_days_current > 0) as late_current_n,
           coalesce(sum(a.vendor_revisions) filter (where a.bucket = 'completed' and a.original_commitment_date is not null), 0) as stab_revisions,
           coalesce(sum(a.revisions), 0) as revisions_all,
           coalesce(sum(a.vendor_revisions), 0) as revisions_vendor,
           count(*) filter (where a.revisions > 0) as revised_jobs,
           count(*) filter (where a.current_commitment_date is not null) as committed_all,
           coalesce(max(a.revisions), 0) as max_revisions,
           count(*) filter (where a.bucket = 'completed' and a.category_median_days is not null) as ct_n,
           sum(a.category_median_days) filter (where a.bucket = 'completed' and a.category_median_days is not null) as ct_expected,
           sum(greatest(a.days_taken, 1)) filter (where a.bucket = 'completed' and a.category_median_days is not null) as ct_actual,
           avg(a.days_taken) filter (where a.bucket = 'completed') as avg_days,
           -- quality: pieces inspected on returned (completed) jobs; jobs cancelled for quality are in the cancellation factor only
           coalesce(sum(a.qty_inspected) filter (where a.bucket = 'completed'), 0) as q_inspected,
           coalesce(sum(a.qty_accepted) filter (where a.bucket = 'completed'), 0) as q_accepted,
           coalesce(sum(a.qty_rejected) filter (where a.bucket = 'completed'), 0) as q_rejected,
           coalesce(sum(a.qty_rework) filter (where a.bucket = 'completed'), 0) as q_rework,
           count(*) filter (where a.bucket = 'completed' and a.qty_inspected > 0) as q_jobs
      from a
     group by a.vendor_id, case when p_by_category then a.category_id end
  ),
  cr as (
    -- cancellations broken out by reason (vendor-caused first); shown beside the score, not scored again
    select z.vendor_id, z.cat_id,
           jsonb_agg(jsonb_build_object('code', z.code, 'label', z.label, 'vendor_caused', z.vc, 'count', z.n)
                     order by z.vc desc, z.n desc, z.code) as cancel_reasons
      from (select a.vendor_id, case when p_by_category then a.category_id end as cat_id,
                   a.cancel_reason_code as code, min(a.cancel_reason_label) as label,
                   bool_or(a.bucket = 'vendor_cancelled') as vc, count(*) as n
              from a
             where a.bucket in ('vendor_cancelled', 'other_cancelled', 'unclassified_cancelled')
             group by 1, 2, 3) z
     group by z.vendor_id, z.cat_id
  ),
  f as (
    select g.*, coalesce(cr.cancel_reasons, '[]'::jsonb) as cancel_reasons,
           case when committed_n > 0 then 100.0 * on_time_n / committed_n end as s_on_time,
           case when committed_n > 0 then
             case when late_n = 0 then 100.0 else 100.0 * (1 - least(1, avg_late / v_cap)) end end as s_delay,
           case when committed_n > 0 then 100.0 * (1 - least(1, stab_revisions::numeric / committed_n / v_rev_cap)) end as s_stability,
           case when ct_n > 0 and ct_actual > 0 then 100.0 * least(1, ct_expected / ct_actual) end as s_completion,
           case when completed + vendor_cancelled > 0 then 100.0 * (1 - vendor_cancelled::numeric / (completed + vendor_cancelled)) end as s_cancel,
           case when q_inspected > 0 then 100.0 * q_accepted / q_inspected end as s_quality
      from g
      left join cr on cr.vendor_id = g.vendor_id and cr.cat_id is not distinct from g.cat_id
  ),
  fx as (
    select f.*, k.*
      from f
     cross join lateral (
       select jsonb_agg(jsonb_build_object(
                'key', x.key, 'weight', x.w, 'score', round(x.s, 1), 'jobs', x.n, 'used', x.s is not null and x.w > 0,
                'note', x.note) order by x.ord) as factors,
              coalesce(sum(x.w) filter (where x.s is not null and x.w > 0), 0) as w_avail,
              count(*) filter (where x.s is not null and x.w > 0) as k_avail,
              sum(x.w * x.s) filter (where x.s is not null and x.w > 0) as ws
         from (values
           (1, 'on_time', coalesce((w ->> 'on_time')::numeric, 0), f.s_on_time, f.committed_n,
               format('%s of %s completed jobs returned on or before the original committed date', f.on_time_n, f.committed_n)),
           (2, 'quality', coalesce((w ->> 'quality')::numeric, 0), f.s_quality, f.q_jobs,
               case when f.q_inspected = 0 then 'No inspected pieces on returned jobs in this period'
                    else format('%s of %s inspected pieces accepted (%s rejected, %s sent for rework) over %s jobs',
                                f.q_accepted, f.q_inspected, f.q_rejected, f.q_rework, f.q_jobs) end),
           (3, 'delay', coalesce((w ->> 'delay')::numeric, 0), f.s_delay, f.committed_n,
               case when f.late_n = 0 then format('None of %s completed jobs was late', f.committed_n)
                    else format('%s late %s, average %s days late (limit %s days)', f.late_n,
                                case when f.late_n = 1 then 'job' else 'jobs' end, round(f.avg_late, 1), v_cap) end),
           (4, 'stability', coalesce((w ->> 'stability')::numeric, 0), f.s_stability, f.committed_n,
               format('%s vendor-requested %s over %s completed jobs (limit %s per job)', f.stab_revisions,
                      case when f.stab_revisions = 1 then 'revision' else 'revisions' end, f.committed_n, v_rev_cap)),
           (5, 'completion_time', coalesce((w ->> 'completion_time')::numeric, 0), f.s_completion, f.ct_n,
               case when f.ct_n = 0 then 'Not enough completed jobs in the category to set a usual time (3 jobs from 2 vendors)'
                    else format('%s days expected (category median) vs %s days taken, over %s jobs', round(f.ct_expected, 1), f.ct_actual, f.ct_n) end),
           (6, 'vendor_cancellation', coalesce((w ->> 'vendor_cancellation')::numeric, 0), f.s_cancel, f.completed + f.vendor_cancelled,
               format('%s vendor-caused %s out of %s eligible jobs', f.vendor_cancelled,
                      case when f.vendor_cancelled = 1 then 'cancellation' else 'cancellations' end, f.completed + f.vendor_cancelled))
         ) as x(ord, key, w, s, n, note)
     ) k
  )
  select jsonb_build_object(
           'vendor_id', fx.vendor_id,
           'vendor_name', fx.vendor_name,
           'category_id', fx.cat_id,
           'category_name', fx.cat_name,
           'score', case when sc.ok then round(fx.ws / fx.w_avail, 1) end,
           'label', case when not sc.ok then null
                         when fx.ws / fx.w_avail >= v_excellent then 'Excellent'
                         when fx.ws / fx.w_avail >= v_good then 'Good'
                         when fx.ws / fx.w_avail >= v_average then 'Average'
                         else 'Needs Improvement' end,
           'status', case when (fx.completed + fx.vendor_cancelled) < v_min_jobs then 'insufficient_jobs'
                          when fx.k_avail < v_min_factors or fx.w_avail = 0 then 'insufficient_factors'
                          else 'scored' end,
           'eligible_jobs', fx.completed + fx.vendor_cancelled,
           'min_eligible_jobs', v_min_jobs,
           'factors_used', fx.k_avail,
           'min_factors', v_min_factors,
           'weight_used', fx.w_avail,
           'factors', fx.factors,
           'counts', jsonb_build_object(
              'total', fx.total, 'completed', fx.completed, 'vendor_cancelled', fx.vendor_cancelled,
              'other_cancelled', fx.other_cancelled, 'unclassified_cancelled', fx.unclassified_cancelled,
              'open', fx.open_jobs, 'open_committed', fx.open_committed, 'overdue_now', fx.overdue_now,
              'closed_no_return', fx.closed_no_return, 'completed_no_commitment', fx.completed_no_commitment,
              'committed_completed', fx.committed_n, 'on_time', fx.on_time_n, 'late', fx.late_n),
           'measures', jsonb_build_object(
              'on_time_pct', case when fx.committed_n > 0 then round(100.0 * fx.on_time_n / fx.committed_n, 1) end,
              'overdue_now_pct', case when fx.open_committed > 0 then round(100.0 * fx.overdue_now / fx.open_committed, 1) end,
              'avg_delay_when_late', round(fx.avg_late, 1),
              'avg_delay_when_late_vs_latest', round(fx.avg_late_current, 1),
              'late_vs_latest', fx.late_current_n,
              'avg_delay_all', case when fx.committed_n > 0 then round(fx.total_late::numeric / fx.committed_n, 1) end,
              'total_delay_days', fx.total_late,
              'avg_days_taken', round(fx.avg_days, 1),
              'quality_acceptance_pct', case when fx.q_inspected > 0 then round(100.0 * fx.q_accepted / fx.q_inspected, 1) end,
              'rework_rejection_pct', case when fx.q_inspected > 0 then round(100.0 * (fx.q_rejected + fx.q_rework) / fx.q_inspected, 1) end,
              'pieces_inspected', fx.q_inspected, 'pieces_accepted', fx.q_accepted, 'pieces_rejected', fx.q_rejected, 'pieces_rework', fx.q_rework,
              'revisions', fx.revisions_all,
              'revisions_vendor', fx.revisions_vendor,
              'revisions_per_committed_job', case when fx.committed_all > 0 then round(fx.revisions_all::numeric / fx.committed_all, 2) end,
              'revised_jobs', fx.revised_jobs,
              'committed_jobs', fx.committed_all,
              'max_revisions_one_job', fx.max_revisions,
              -- "frequently revises": at least 3 committed jobs and half or more of them revised, or one job revised
              -- as often as the stability limit
              'frequent_reviser', (fx.committed_all >= 3 and fx.revised_jobs * 2 >= fx.committed_all) or fx.max_revisions >= v_rev_cap),
           'cancel_reasons', fx.cancel_reasons
         )
    from fx
   cross join lateral (
     select (fx.completed + fx.vendor_cancelled) >= v_min_jobs and fx.k_avail >= v_min_factors and fx.w_avail > 0 as ok
   ) sc
   order by case when sc.ok then fx.ws / fx.w_avail end desc nulls last, fx.completed + fx.vendor_cancelled desc, fx.vendor_name;
end;
$$;

create or replace function public.vendor_reliability_jobs(p_vendor_id uuid, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date; v_to date; v_cat uuid := private.j_uuid(coalesce(p, '{}'::jsonb), 'category_id', false, 'Category');
begin
  perform private.require_permission('reliability.view');
  if p_vendor_id is null then
    raise exception 'Vendor is required.' using errcode = '22023';
  end if;
  select r.p_from, r.p_to into v_from, v_to from private.reliability_period(coalesce(p, '{}'::jsonb)) r;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'assignment_id', x.assignment_id, 'job_id', x.job_id, 'job_no', x.job_no, 'part_label', x.part_label,
             'category_name', x.category_name, 'sequence_no', x.sequence_no, 'dispatched_on', x.dispatched_on,
             'original_commitment_date', x.original_commitment_date, 'current_commitment_date', x.current_commitment_date,
             'completed_on', x.completed_on, 'cancelled_on', x.cancelled_on,
             'cancel_reason_code', x.cancel_reason_code, 'cancel_reason_label', x.cancel_reason_label,
             'bucket', x.bucket, 'days_taken', x.days_taken, 'late_days', x.late_days, 'late_days_current', x.late_days_current,
             'revisions', x.revisions, 'vendor_revisions', x.vendor_revisions, 'overdue_now', x.overdue_now,
             'category_median_days', x.category_median_days,
             'qty_inspected', x.qty_inspected, 'qty_accepted', x.qty_accepted, 'qty_rejected', x.qty_rejected, 'qty_rework', x.qty_rework,
             'used_in', to_jsonb(array_remove(array[
                case when x.bucket = 'completed' and x.original_commitment_date is not null then 'on_time' end,
                case when x.bucket = 'completed' and x.qty_inspected > 0 then 'quality' end,
                case when x.bucket = 'completed' and x.original_commitment_date is not null then 'delay' end,
                case when x.bucket = 'completed' and x.original_commitment_date is not null then 'stability' end,
                case when x.bucket = 'completed' and x.category_median_days is not null then 'completion_time' end,
                case when x.bucket in ('completed', 'vendor_cancelled') then 'vendor_cancellation' end], null)),
             'excluded_because', case x.bucket
                when 'other_cancelled' then 'Cancelled for a reason not caused by the vendor'
                when 'unclassified_cancelled' then 'Imported cancellation without a reason: classify it in Missing Data Review'
                when 'open' then 'Still with the vendor'
                when 'closed_no_return' then 'Job closed without a recorded return'
                when 'completed' then case when x.original_commitment_date is null
                  then 'No committed date: left out of on-time, delay and stability' end
             end)
           order by x.dispatched_on desc, x.job_no)
      from private.reliability_assignments(v_from, v_to, v_cat) x
     where x.vendor_id = p_vendor_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Row Level Security, grants, realtime
-- ---------------------------------------------------------------------------
alter table public.material_returns enable row level security;
alter table public.quality_inspections enable row level security;
revoke all on public.material_returns, public.quality_inspections from anon, authenticated;
revoke update, delete, truncate on public.material_returns, public.quality_inspections from service_role;
grant select on public.material_returns, public.quality_inspections to authenticated;
create policy material_returns_read on public.material_returns for select to authenticated using (
  (select private.has_permission('jobs.view_all'))
  or exists (select 1 from public.jobs j where j.id = job_id));  -- jobs RLS decides
create policy quality_inspections_read on public.quality_inspections for select to authenticated using (
  (select private.has_permission('jobs.view_all'))
  or exists (select 1 from public.jobs j where j.id = job_id));

revoke all on public.job_register, public.assignment_quantities, public.material_return_lots, public.quality_inspection_log from anon, authenticated;
grant select on public.job_register, public.assignment_quantities, public.material_return_lots, public.quality_inspection_log to authenticated;

revoke execute on function
  public.record_return(uuid, jsonb), public.record_inspection(uuid, jsonb), public.void_return(uuid, text),
  public.void_inspection(uuid, text), public.close_job(uuid, integer, text), public.reopen_job(uuid, integer, text)
from public, anon;
grant execute on function
  public.record_return(uuid, jsonb), public.record_inspection(uuid, jsonb), public.void_return(uuid, text),
  public.void_inspection(uuid, text), public.close_job(uuid, integer, text), public.reopen_job(uuid, integer, text)
to authenticated;

-- building blocks used inside the checked functions only
revoke execute on function private.try_complete_assignment(uuid) from public, anon, authenticated, service_role;
revoke execute on function private.open_assignment_for_update(uuid) from public, anon, authenticated, service_role;
revoke execute on function private.add_inspection(public.material_returns, jsonb) from public, anon, authenticated, service_role;
revoke execute on function private.reliability_assignments(date, date, uuid) from public, anon, authenticated, service_role;
-- used by views that signed-in users read (security_invoker): callable, read-only
revoke execute on function private.assignment_quantities(uuid), private.quality_status(integer, integer, integer, integer),
  private.job_status_full(boolean, boolean, date, date, date, integer, integer, integer, integer), private.j_int0(jsonb, text, text),
  private.guard_void_only()
from public, anon;
grant execute on function private.assignment_quantities(uuid), private.quality_status(integer, integer, integer, integer),
  private.job_status_full(boolean, boolean, date, date, date, integer, integer, integer, integer)
to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.material_returns, public.quality_inspections;
  end if;
end;
$$;
