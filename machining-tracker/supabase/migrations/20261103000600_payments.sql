-- =====================================================================================
-- Phase 6 (part 2): vendor payments. One payment account per vendor assignment (the vendor who did the work):
--   Total payable = job amount + additional charges - discounts
--   Balance       = total payable - total paid (advances included)
-- Ledger entries are never edited or deleted: a mistake is reversed by a new, linked entry with a reason.
-- Adding entries is Admin-only by default (payments.add / payments.manage); Managers can view (payments.view).
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Vendor invoice details on the assignment; the job amount is the payable base
-- ---------------------------------------------------------------------------
alter table public.job_assignments
  add column invoice_no   text check (invoice_no is null or length(invoice_no) between 1 and 100),
  add column invoice_date date;

create table public.payment_adjustments (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null references public.job_assignments (id),
  job_id         uuid not null references public.jobs (id),
  vendor_id      uuid not null references public.vendors (id),
  kind           text not null check (kind in ('additional_charge', 'discount')),
  entry_date     date not null,
  amount         numeric(14, 2) not null,
  description    text not null check (length(trim(description)) between 3 and 500),
  reversal_of    uuid references public.payment_adjustments (id),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  constraint payment_adjustment_sign check ((reversal_of is null and amount > 0) or (reversal_of is not null and amount < 0))
);
create unique index payment_adjustments_one_reversal on public.payment_adjustments (reversal_of) where reversal_of is not null;
create index payment_adjustments_assignment_idx on public.payment_adjustments (assignment_id);

create table public.vendor_payments (
  id             uuid primary key default gen_random_uuid(),
  payment_no     text not null unique,
  assignment_id  uuid not null references public.job_assignments (id),
  job_id         uuid not null references public.jobs (id),
  vendor_id      uuid not null references public.vendors (id),
  kind           text not null check (kind in ('advance', 'payment')),
  paid_on        date not null,
  amount         numeric(14, 2) not null,
  mode           text not null check (mode in ('bank_transfer', 'upi', 'cheque', 'cash', 'other')),
  reference      text not null default '' check (length(reference) <= 100),
  remarks        text not null default '' check (length(remarks) <= 1000),
  reversal_of    uuid references public.vendor_payments (id),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  constraint vendor_payment_sign check ((reversal_of is null and amount > 0) or (reversal_of is not null and amount < 0)),
  constraint vendor_payment_reversal_reason check (reversal_of is null or length(trim(remarks)) >= 3)
);
create unique index vendor_payments_one_reversal on public.vendor_payments (reversal_of) where reversal_of is not null;
create index vendor_payments_assignment_idx on public.vendor_payments (assignment_id);
create index vendor_payments_vendor_idx on public.vendor_payments (vendor_id, paid_on);
create index vendor_payments_paid_on_idx on public.vendor_payments (paid_on);

create trigger payment_adjustments_append_only before update or delete on public.payment_adjustments
  for each row execute function private.forbid_change();
create trigger payment_adjustments_no_truncate before truncate on public.payment_adjustments
  for each statement execute function private.forbid_change();
create trigger vendor_payments_append_only before update or delete on public.vendor_payments
  for each row execute function private.forbid_change();
create trigger vendor_payments_no_truncate before truncate on public.vendor_payments
  for each statement execute function private.forbid_change();
create trigger payment_adjustments_audit after insert on public.payment_adjustments
  for each row execute function private.audit_row('id', 'payments');
create trigger vendor_payments_audit after insert on public.vendor_payments
  for each row execute function private.audit_row('id', 'payments');

-- Once money is recorded against an assignment, its job amount changes only through "Record vendor invoice".
create or replace function private.guard_assignment_amount()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.amount is distinct from old.amount and coalesce(current_setting('cess.billing', true), '') <> 'on'
     and (exists (select 1 from public.vendor_payments p where p.assignment_id = old.id)
          or exists (select 1 from public.payment_adjustments d where d.assignment_id = old.id)) then
    raise exception 'Payments are recorded for this vendor: the job amount can be changed only through "Record vendor invoice" (Admin).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger job_assignments_amount_guard before update of amount on public.job_assignments
  for each row execute function private.guard_assignment_amount();

-- ---------------------------------------------------------------------------
-- 2. Calculations
-- ---------------------------------------------------------------------------
create or replace function private.payment_status(p_payable numeric, p_paid numeric, p_regular numeric)
returns text language sql immutable set search_path = '' as $$
  select case
    when coalesce(p_paid, 0) <= 0 then 'Unpaid'
    when p_payable is not null and p_paid >= p_payable then 'Fully Paid'
    when coalesce(p_regular, 0) <= 0 then 'Advance Paid'
    else 'Partially Paid' end
$$;

-- One row per vendor assignment that has a job amount or any money entry (Managers and Admin; payments.view).
create view public.payment_accounts with (security_invoker = true) as
select a.id as assignment_id, a.job_id, j.job_no, j.part_label, c.name as category_name, a.vendor_id, v.name as vendor_name,
       a.sequence_no, a.state as assignment_state, a.dispatched_on, a.completed_on, a.cancelled_on, a.version as assignment_version,
       a.qty_sent, a.amount as job_amount, a.invoice_no, a.invoice_date,
       s.charges as additional_charges, s.discounts as discount, s.advance as advance_paid, s.regular as regular_paid,
       s.paid as amount_paid,
       case when a.amount is not null then a.amount + s.charges - s.discounts end as total_payable,
       case when a.amount is not null then a.amount + s.charges - s.discounts - s.paid end as balance,
       private.payment_status(case when a.amount is not null then a.amount + s.charges - s.discounts end, s.paid, s.regular) as payment_status,
       s.last_paid_on, s.payments as payment_count,
       private.fy_label(a.dispatched_on) as financial_year,
       j.archived_at is not null as archived
  from public.job_assignments a
  join public.jobs j on j.id = a.job_id
  join public.work_categories c on c.id = j.category_id
  join public.vendors v on v.id = a.vendor_id
 cross join lateral (
   select coalesce((select sum(d.amount) from public.payment_adjustments d where d.assignment_id = a.id and d.kind = 'additional_charge'), 0) as charges,
          coalesce((select sum(d.amount) from public.payment_adjustments d where d.assignment_id = a.id and d.kind = 'discount'), 0) as discounts,
          coalesce((select sum(p.amount) from public.vendor_payments p where p.assignment_id = a.id), 0) as paid,
          coalesce((select sum(p.amount) from public.vendor_payments p where p.assignment_id = a.id and p.kind = 'advance'), 0) as advance,
          coalesce((select sum(p.amount) from public.vendor_payments p where p.assignment_id = a.id and p.kind = 'payment'), 0) as regular,
          (select max(p.paid_on) from public.vendor_payments p where p.assignment_id = a.id and p.reversal_of is null) as last_paid_on,
          (select count(*)::int from public.vendor_payments p where p.assignment_id = a.id and p.reversal_of is null
              and not exists (select 1 from public.vendor_payments r where r.reversal_of = p.id)) as payments
 ) s
 where (select private.has_permission('payments.view'))
   and (a.amount is not null
        or exists (select 1 from public.vendor_payments p where p.assignment_id = a.id)
        or exists (select 1 from public.payment_adjustments d where d.assignment_id = a.id));

-- Every money entry, newest first, with names (payments.view).
create view public.payment_ledger with (security_invoker = true) as
select 'payment'::text as entry_type, p.id, p.payment_no as entry_no, p.assignment_id, p.job_id, j.job_no, j.part_label,
       p.vendor_id, v.name as vendor_name, p.kind, p.paid_on as entry_date, p.amount, p.mode, p.reference, p.remarks,
       p.reversal_of, exists (select 1 from public.vendor_payments r where r.reversal_of = p.id) as reversed,
       p.created_at, private.user_name(p.created_by) as recorded_by_name
  from public.vendor_payments p
  join public.jobs j on j.id = p.job_id
  join public.vendors v on v.id = p.vendor_id
 where (select private.has_permission('payments.view'))
union all
select 'adjustment', d.id, null, d.assignment_id, d.job_id, j.job_no, j.part_label, d.vendor_id, v.name, d.kind, d.entry_date,
       d.amount, null, '', d.description, d.reversal_of, exists (select 1 from public.payment_adjustments r where r.reversal_of = d.id),
       d.created_at, private.user_name(d.created_by)
  from public.payment_adjustments d
  join public.jobs j on j.id = d.job_id
  join public.vendors v on v.id = d.vendor_id
 where (select private.has_permission('payments.view'));

-- ---------------------------------------------------------------------------
-- 3. Functions (Admin by default)
-- ---------------------------------------------------------------------------
create or replace function private.account_totals(p_assignment_id uuid, out amount numeric, out payable numeric, out paid numeric)
language sql stable security definer set search_path = '' as $$
  select a.amount,
         a.amount + coalesce((select sum(d.amount) from public.payment_adjustments d where d.assignment_id = a.id and d.kind = 'additional_charge'), 0)
                  - coalesce((select sum(d.amount) from public.payment_adjustments d where d.assignment_id = a.id and d.kind = 'discount'), 0),
         coalesce((select sum(p.amount) from public.vendor_payments p where p.assignment_id = a.id), 0)
    from public.job_assignments a where a.id = p_assignment_id
$$;

create or replace function private.money_assignment(p_assignment_id uuid)
returns public.job_assignments language plpgsql volatile security definer set search_path = '' as $$
declare a public.job_assignments;
begin
  select * into a from public.job_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'Vendor assignment not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.jobs j where j.id = a.job_id and j.archived_at is not null) then
    raise exception 'This job is archived.' using errcode = '22023';
  end if;
  return a;
end;
$$;

-- Records the vendor's invoice: number, date and invoice amount (becomes the job amount = payable base).
-- Changing an amount that is already recorded needs "payments.manage" and a reason.
create or replace function public.record_vendor_invoice(p_assignment_id uuid, p_expected_version integer, p jsonb, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  t record;
  v_amount numeric := private.j_money(p, 'amount', 'Invoice amount');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_adj numeric;
begin
  perform private.require_permission('payments.add');
  a := private.money_assignment(p_assignment_id);
  perform private.require_version(a.version, p_expected_version, 'This vendor assignment');
  if v_amount is null or v_amount <= 0 then
    raise exception 'Enter the invoice amount.' using errcode = '22023';
  end if;
  if private.j_date(p, 'invoice_date', false, 'Invoice date') > private.today_ist() then
    raise exception 'The invoice date cannot be in the future.' using errcode = '22023';
  end if;
  if a.amount is not null and v_amount <> a.amount then
    perform private.require_permission('payments.manage');
    if v_reason is null or length(v_reason) < 3 then
      raise exception 'The job amount is already % : give the reason for changing it.', a.amount using errcode = '22023';
    end if;
  end if;
  select * into t from private.account_totals(a.id);
  v_adj := coalesce((select sum(case d.kind when 'additional_charge' then d.amount else -d.amount end)
                       from public.payment_adjustments d where d.assignment_id = a.id), 0);
  if t.paid > v_amount + v_adj then
    raise exception 'The payable amount (%) cannot be less than what is already paid (%).', v_amount + v_adj, t.paid using errcode = '22023';
  end if;
  perform private.set_audit_context('payment.invoice_recorded', v_reason);
  perform set_config('cess.billing', 'on', true);
  update public.job_assignments set amount = v_amount,
         invoice_no = private.j_text(p, 'invoice_no', 100, false, 'Invoice number'),
         invoice_date = private.j_date(p, 'invoice_date', false, 'Invoice date')
   where id = a.id returning * into a;
  perform set_config('cess.billing', '', true);
  perform private.set_audit_context(null, null);
  return to_jsonb(a);
end;
$$;

-- Payload: kind ('advance' | 'payment'), paid_on, amount, mode, reference, remarks
create or replace function public.add_vendor_payment(p_assignment_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  t record;
  v_kind text := coalesce(p ->> 'kind', '');
  v_mode text := coalesce(p ->> 'mode', '');
  v_date date := private.j_date(p, 'paid_on', true, 'Payment date');
  v_amount numeric := private.j_money(p, 'amount', 'Amount paid');
  v_row public.vendor_payments;
  v_fy text;
begin
  perform private.require_permission('payments.add');
  a := private.money_assignment(p_assignment_id);
  if v_kind not in ('advance', 'payment') then
    raise exception 'Choose whether this is an advance or a payment.' using errcode = '22023';
  end if;
  if v_mode not in ('bank_transfer', 'upi', 'cheque', 'cash', 'other') then
    raise exception 'Choose the payment mode.' using errcode = '22023';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Enter the amount paid (more than ₹0).' using errcode = '22023';
  end if;
  if v_date < date '2015-01-01' or v_date > private.today_ist() then
    raise exception 'Payment date must be between 01-Jan-2015 and today.' using errcode = '22023';
  end if;
  select * into t from private.account_totals(a.id);
  if t.payable is null and v_kind = 'payment' then
    raise exception 'The job amount is not recorded yet. Record the vendor invoice first, or record this as an advance.' using errcode = '22023';
  end if;
  if t.payable is not null and t.paid + v_amount > t.payable then
    raise exception 'This is more than the balance of % (payable %, already paid %).', t.payable - t.paid, t.payable, t.paid using errcode = '22023';
  end if;
  v_fy := private.fy_code(v_date);
  perform private.set_audit_context(case v_kind when 'advance' then 'payment.advance_added' else 'payment.added' end, null);
  insert into public.vendor_payments (payment_no, assignment_id, job_id, vendor_id, kind, paid_on, amount, mode, reference, remarks)
  values ('PAY-' || v_fy || '-' || lpad(private.next_number('pay:' || v_fy)::text, 4, '0'), a.id, a.job_id, a.vendor_id, v_kind, v_date,
          v_amount, v_mode, coalesce(private.j_text(p, 'reference', 100, false, 'Transaction reference'), ''),
          coalesce(private.j_text(p, 'remarks', 1000, false, 'Payment remarks'), ''))
  returning * into v_row;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_row);
end;
$$;

-- Payload: kind ('additional_charge' | 'discount'), entry_date, amount, description
create or replace function public.add_payment_adjustment(p_assignment_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  t record;
  v_kind text := coalesce(p ->> 'kind', '');
  v_date date := private.j_date(p, 'entry_date', true, 'Date');
  v_amount numeric := private.j_money(p, 'amount', 'Amount');
  v_row public.payment_adjustments;
begin
  perform private.require_permission('payments.add');
  a := private.money_assignment(p_assignment_id);
  if v_kind not in ('additional_charge', 'discount') then
    raise exception 'Choose additional charge or discount.' using errcode = '22023';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Enter the amount (more than ₹0).' using errcode = '22023';
  end if;
  if v_date < date '2015-01-01' or v_date > private.today_ist() then
    raise exception 'Date must be between 01-Jan-2015 and today.' using errcode = '22023';
  end if;
  select * into t from private.account_totals(a.id);
  if v_kind = 'discount' then
    if t.payable is null then
      raise exception 'Record the job amount (vendor invoice) before a discount.' using errcode = '22023';
    end if;
    if t.payable - v_amount < t.paid then
      raise exception 'The discount would make the payable amount less than what is already paid (%).', t.paid using errcode = '22023';
    end if;
    if t.payable - v_amount < 0 then
      raise exception 'The discount is larger than the payable amount.' using errcode = '22023';
    end if;
  end if;
  perform private.set_audit_context(case v_kind when 'discount' then 'payment.discount_added' else 'payment.charge_added' end, null);
  insert into public.payment_adjustments (assignment_id, job_id, vendor_id, kind, entry_date, amount, description)
  values (a.id, a.job_id, a.vendor_id, v_kind, v_date, v_amount, private.j_text(p, 'description', 500, true, 'Description'))
  returning * into v_row;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_row);
end;
$$;

create or replace function public.reverse_vendor_payment(p_payment_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.vendor_payments; v_reason text; v_row public.vendor_payments; v_fy text := private.fy_code(private.today_ist());
begin
  perform private.require_permission('payments.manage');
  v_reason := private.require_reason(p_reason);
  select * into p from public.vendor_payments where id = p_payment_id;
  if not found then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  perform private.money_assignment(p.assignment_id);
  if p.reversal_of is not null then
    raise exception 'A reversal cannot be reversed. Record a new payment instead.' using errcode = '22023';
  end if;
  if exists (select 1 from public.vendor_payments r where r.reversal_of = p.id) then
    raise exception 'This payment is already reversed.' using errcode = '22023';
  end if;
  perform private.set_audit_context('payment.reversed', v_reason);
  insert into public.vendor_payments (payment_no, assignment_id, job_id, vendor_id, kind, paid_on, amount, mode, reference, remarks, reversal_of)
  values ('PAY-' || v_fy || '-' || lpad(private.next_number('pay:' || v_fy)::text, 4, '0'), p.assignment_id, p.job_id, p.vendor_id, p.kind,
          private.today_ist(), -p.amount, p.mode, p.payment_no, 'Reversal of ' || p.payment_no || ': ' || v_reason, p.id)
  returning * into v_row;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_row);
end;
$$;

create or replace function public.reverse_payment_adjustment(p_adjustment_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d public.payment_adjustments; t record; v_reason text; v_row public.payment_adjustments;
begin
  perform private.require_permission('payments.manage');
  v_reason := private.require_reason(p_reason);
  select * into d from public.payment_adjustments where id = p_adjustment_id;
  if not found then
    raise exception 'Entry not found.' using errcode = 'P0002';
  end if;
  perform private.money_assignment(d.assignment_id);
  if d.reversal_of is not null or exists (select 1 from public.payment_adjustments r where r.reversal_of = d.id) then
    raise exception 'This entry is already a reversal or already reversed.' using errcode = '22023';
  end if;
  select * into t from private.account_totals(d.assignment_id);
  if d.kind = 'additional_charge' and t.payable - d.amount < t.paid then
    raise exception 'Removing this charge would make the payable amount less than what is already paid (%). Reverse a payment first.', t.paid
      using errcode = '22023';
  end if;
  perform private.set_audit_context('payment.adjustment_reversed', v_reason);
  insert into public.payment_adjustments (assignment_id, job_id, vendor_id, kind, entry_date, amount, description, reversal_of)
  values (d.assignment_id, d.job_id, d.vendor_id, d.kind, private.today_ist(), -d.amount, 'Reversal: ' || v_reason, d.id)
  returning * into v_row;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reports (payments.view)
-- ---------------------------------------------------------------------------
-- Vendor-wise payable / paid / outstanding. Filter p: { fy } = jobs given to the vendor in that financial year.
create or replace function public.vendor_payment_summary(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date; v_to date;
begin
  perform private.require_permission('payments.view');
  select r.p_from, r.p_to into v_from, v_to from private.reliability_period(coalesce(p, '{}'::jsonb)) r;
  return coalesce((
    select jsonb_agg(x order by x ->> 'vendor_name')
      from (select jsonb_build_object(
                     'vendor_id', pa.vendor_id, 'vendor_name', min(pa.vendor_name),
                     'accounts', count(*),
                     'job_amount', coalesce(sum(pa.job_amount), 0),
                     'additional_charges', sum(pa.additional_charges), 'discount', sum(pa.discount),
                     'total_payable', coalesce(sum(pa.total_payable), 0),
                     'amount_paid', sum(pa.amount_paid), 'advance_paid', sum(pa.advance_paid),
                     'outstanding', coalesce(sum(pa.balance) filter (where pa.balance > 0), 0),
                     'unpriced_accounts', count(*) filter (where pa.job_amount is null),
                     'fully_paid', count(*) filter (where pa.payment_status = 'Fully Paid'),
                     'last_paid_on', max(pa.last_paid_on)) as x
              from public.payment_accounts pa
             where (v_from is null or pa.dispatched_on >= v_from) and (v_to is null or pa.dispatched_on <= v_to)
             group by pa.vendor_id) z), '[]'::jsonb);
end;
$$;

-- Money paid per month of one financial year (by payment date, reversals netted) and per financial year.
create or replace function public.payments_by_period(p_fy text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date; v_to date;
begin
  perform private.require_permission('payments.view');
  select r.p_from, r.p_to into v_from, v_to from private.reliability_period(jsonb_build_object('fy', coalesce(p_fy, private.fy_label(private.today_ist())))) r;
  return jsonb_build_object(
    'fy', private.fy_label(v_from),
    'months', (select jsonb_agg(jsonb_build_object('month', to_char(mm.m0, 'YYYY-MM'),
                 'paid', coalesce((select sum(p.amount) from public.vendor_payments p where p.paid_on >= mm.m0 and p.paid_on < mm.m1), 0),
                 'advances', coalesce((select sum(p.amount) from public.vendor_payments p where p.paid_on >= mm.m0 and p.paid_on < mm.m1 and p.kind = 'advance'), 0),
                 'entries', (select count(*) from public.vendor_payments p where p.paid_on >= mm.m0 and p.paid_on < mm.m1 and p.reversal_of is null))
               order by mm.m0)
                 from (select g::date as m0, (g + interval '1 month')::date as m1
                         from generate_series(v_from::timestamp, v_to::timestamp, interval '1 month') g) mm),
    'years', coalesce((select jsonb_agg(jsonb_build_object('fy', y.fy, 'paid', y.paid, 'entries', y.n) order by y.fy desc)
                 from (select private.fy_label(p.paid_on) as fy, sum(p.amount) as paid, count(*) filter (where p.reversal_of is null) as n
                         from public.vendor_payments p group by 1) y), '[]'::jsonb));
end;
$$;

-- Vendor statement: opening balance, every bill / charge / discount / payment in the period, running balance.
create or replace function public.vendor_statement(p_vendor_id uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_opening numeric;
begin
  perform private.require_permission('payments.view');
  if p_vendor_id is null then
    raise exception 'Vendor is required.' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The From date must be before the To date.' using errcode = '22023';
  end if;
  return (
    with lines as (
      select coalesce(a.invoice_date, a.completed_on, a.dispatched_on) as d, 1 as ord, 'Job amount' as kind, j.job_no, j.part_label,
             coalesce(a.invoice_no, '') as reference, a.amount as payable, 0::numeric as paid, a.id::text as k
        from public.job_assignments a join public.jobs j on j.id = a.job_id
       where a.vendor_id = p_vendor_id and a.amount is not null
      union all
      select d.entry_date, 2, case when d.reversal_of is not null then 'Reversal of ' else '' end
                              || case d.kind when 'additional_charge' then 'Additional charge' else 'Discount' end,
             j.job_no, j.part_label, d.description,
             case d.kind when 'additional_charge' then d.amount else -d.amount end, 0, d.created_at::text || d.id::text
        from public.payment_adjustments d join public.jobs j on j.id = d.job_id
       where d.vendor_id = p_vendor_id
      union all
      select p.paid_on, 3, case when p.reversal_of is not null then 'Payment reversal' when p.kind = 'advance' then 'Advance' else 'Payment' end,
             j.job_no, j.part_label, concat_ws(' · ', p.payment_no, nullif(p.reference, ''), nullif(p.remarks, '')), 0, p.amount,
             p.created_at::text || p.id::text
        from public.vendor_payments p join public.jobs j on j.id = p.job_id
       where p.vendor_id = p_vendor_id
    ),
    opening as (
      select coalesce(sum(l.payable - l.paid), 0) as bal from lines l where p_from is not null and l.d < p_from
    ),
    period as (
      select l.*, (select bal from opening) + sum(l.payable - l.paid) over (order by l.d, l.ord, l.job_no, l.k rows unbounded preceding) as running
        from lines l
       where (p_from is null or l.d >= p_from) and (p_to is null or l.d <= p_to)
    )
    select jsonb_build_object(
      'vendor', (select jsonb_build_object('id', v.id, 'name', v.name, 'vendor_code', v.vendor_code, 'company_name', v.company_name,
                                           'gst_no', v.gst_no, 'address', v.address) from public.vendors v where v.id = p_vendor_id),
      'from', p_from, 'to', p_to,
      'opening_balance', (select bal from opening),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'type', kind, 'job_no', job_no, 'part_label', part_label,
                                 'reference', reference, 'payable', payable, 'paid', paid, 'balance', running)
                                 order by d, ord, job_no, k) from period), '[]'::jsonb),
      'total_payable', coalesce((select sum(payable) from period), 0),
      'total_paid', coalesce((select sum(paid) from period), 0),
      'closing_balance', (select bal from opening) + coalesce((select sum(payable - paid) from period), 0)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security, grants, realtime
-- ---------------------------------------------------------------------------
alter table public.payment_adjustments enable row level security;
alter table public.vendor_payments enable row level security;
revoke all on public.payment_adjustments, public.vendor_payments from anon, authenticated;
revoke update, delete, truncate on public.payment_adjustments, public.vendor_payments from service_role;
grant select on public.payment_adjustments, public.vendor_payments to authenticated;
create policy payment_adjustments_read on public.payment_adjustments for select to authenticated using ((select private.has_permission('payments.view')));
create policy vendor_payments_read on public.vendor_payments for select to authenticated using ((select private.has_permission('payments.view')));

revoke all on public.payment_accounts, public.payment_ledger from anon, authenticated;
grant select on public.payment_accounts, public.payment_ledger to authenticated;

revoke execute on function
  public.record_vendor_invoice(uuid, integer, jsonb, text), public.add_vendor_payment(uuid, jsonb), public.add_payment_adjustment(uuid, jsonb),
  public.reverse_vendor_payment(uuid, text), public.reverse_payment_adjustment(uuid, text), public.vendor_payment_summary(jsonb),
  public.payments_by_period(text), public.vendor_statement(uuid, date, date)
from public, anon;
grant execute on function
  public.record_vendor_invoice(uuid, integer, jsonb, text), public.add_vendor_payment(uuid, jsonb), public.add_payment_adjustment(uuid, jsonb),
  public.reverse_vendor_payment(uuid, text), public.reverse_payment_adjustment(uuid, text), public.vendor_payment_summary(jsonb),
  public.payments_by_period(text), public.vendor_statement(uuid, date, date)
to authenticated;

revoke execute on function private.account_totals(uuid), private.money_assignment(uuid), private.guard_assignment_amount() from public, anon, authenticated, service_role;
revoke execute on function private.payment_status(numeric, numeric, numeric) from public, anon;
grant execute on function private.payment_status(numeric, numeric, numeric) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payment_adjustments, public.vendor_payments;
  end if;
end;
$$;
