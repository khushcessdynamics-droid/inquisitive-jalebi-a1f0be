-- =====================================================================================
-- CESS Machining Job Tracker - Phase 3 foundation
--   * roles, permissions, user profiles, per-user permission overrides
--   * server-side session checks (revocation, idle timeout, max lifetime) and MFA (aal2)
--   * append-only activity log + generic audit trigger
--   * settings and master data (work categories, Given By names, cancellation reasons)
--   * Row Level Security on every table
-- Conventions:
--   * public schema  = tables + RPCs exposed through the Supabase REST API (protected by RLS/grants)
--   * private schema = internal helpers, NOT exposed through the API
--   * every business table has version (optimistic locking), created/updated by/at
--   * nothing important is hard-deleted; rows are deactivated
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 0. Schema and default privileges
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- Nothing new in public is readable or callable by anonymous users unless granted explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon, public;
alter default privileges for role postgres in schema private revoke execute on functions from anon, public;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- 1.1 Roles (Admin / Manager / Staff). MFA policy lives here so it can change without code changes.
create table public.roles (
  key           text primary key check (key ~ '^[a-z_]{3,30}$'),
  label         text not null check (length(trim(label)) between 1 and 60),
  description   text not null default '',
  mfa_required  boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  version       integer not null default 1,
  -- Approved rule: MFA is mandatory for Admin and Manager.
  constraint roles_mfa_mandatory_for_admin_manager check (key not in ('admin', 'manager') or mfa_required)
);

-- 1.2 Permission catalogue
create table public.permissions (
  key          text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module       text not null,
  label        text not null,
  description  text not null default '',
  admin_only   boolean not null default false,  -- can never be granted to non-Admin roles/users
  sort_order   integer not null default 0
);

-- 1.3 Role -> permission grants (Admin implicitly has everything and is not stored here)
create table public.role_permissions (
  role_key        text not null references public.roles (key) on update cascade on delete cascade,
  permission_key  text not null references public.permissions (key) on delete cascade,
  granted_at      timestamptz not null default now(),
  granted_by      uuid,
  primary key (role_key, permission_key),
  constraint role_permissions_not_admin check (role_key <> 'admin')
);

-- 1.4 One profile per Supabase Auth user
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete restrict,
  email                text not null,
  full_name            text not null default '' check (length(full_name) <= 120),
  role_key             text not null default 'staff' references public.roles (key) on update cascade,
  is_active            boolean not null default false,
  deactivated_at       timestamptz,
  deactivated_by       uuid,
  deactivation_reason  text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  version              integer not null default 1
);
create unique index profiles_email_key on public.profiles (lower(email));
create index profiles_role_idx on public.profiles (role_key) where is_active;

-- 1.5 Per-user exceptions to the role defaults (grant or deny a single permission)
create table public.user_permission_overrides (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  permission_key  text not null references public.permissions (key) on delete cascade,
  granted         boolean not null,
  reason          text not null check (length(trim(reason)) >= 3),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  primary key (user_id, permission_key)
);

-- 1.6 Server-side activity per Auth session (idle timeout; Supabase's own timeout is Pro-only)
create table public.session_activity (
  session_id    uuid primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  last_seen_at  timestamptz not null default now()
);
create index session_activity_user_idx on public.session_activity (user_id);

-- 1.7 Append-only activity & change history
create table public.activity_log (
  id              bigint generated always as identity primary key,
  occurred_at     timestamptz not null default now(),
  actor_id        uuid,
  actor_name      text,
  actor_role      text,
  source          text not null default 'app' check (source in ('app', 'service', 'sql', 'system')),
  action          text not null,
  module          text not null,
  entity_table    text,
  entity_id       text,
  job_id          uuid,
  vendor_id       uuid,
  previous_value  jsonb,
  new_value       jsonb,
  reason          text,
  session_id      uuid,
  aal             text
);
create index activity_log_occurred_idx on public.activity_log (occurred_at desc);
create index activity_log_actor_idx on public.activity_log (actor_id, occurred_at desc);
create index activity_log_module_idx on public.activity_log (module, occurred_at desc);
create index activity_log_entity_idx on public.activity_log (entity_table, entity_id);
create index activity_log_job_idx on public.activity_log (job_id) where job_id is not null;
create index activity_log_vendor_idx on public.activity_log (vendor_id) where vendor_id is not null;

-- 1.8 Settings (non-secret). API keys/passwords are NEVER stored here; they live in environment secrets.
create table public.app_settings (
  key          text primary key check (key ~ '^[a-z_]{3,40}$'),
  label        text not null,
  value        jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  version      integer not null default 1
);

-- 1.9 Master data
create table public.work_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create unique index work_categories_name_key on public.work_categories (lower(trim(name)));

create table public.given_by_names (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create unique index given_by_names_name_key on public.given_by_names (lower(trim(name)));

-- Cancellation reasons drive the reliability score: vendor_related = true counts against the vendor.
create table public.cancel_reason_codes (
  code            text primary key check (code ~ '^[a-z0-9_]{3,40}$'),
  label           text not null check (length(trim(label)) between 3 and 120),
  vendor_related  boolean not null,
  vendor_subtype  text check (vendor_subtype in ('delivery', 'refusal', 'incomplete', 'quality', 'repeated_commitment')),
  is_active       boolean not null default true,
  is_system       boolean not null default false,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  version         integer not null default 1,
  constraint cancel_reason_subtype_matches check (
    (vendor_related and vendor_subtype is not null) or (not vendor_related and vendor_subtype is null)
  )
);

-- 1.10 Backup run history (written by the local backup tool with the service key)
create table public.backup_runs (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('scheduled', 'manual', 'pre_restore', 'pre_migration')),
  status                text not null check (status in ('running', 'failed', 'unverified', 'verified')),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  verified_at           timestamptz,
  archive_name          text,
  size_bytes            bigint,
  sha256                text,
  row_counts            jsonb,
  object_count          integer,
  verification_details  jsonb,
  error                 text,
  machine_label         text
);
create index backup_runs_started_idx on public.backup_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- 2. Internal helper functions (private schema)
-- ---------------------------------------------------------------------------

-- Business "today" is always the date in India.
create or replace function private.today_ist()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

create or replace function private.setting_int(p_key text, p_field text, p_default integer)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.value ->> p_field)::integer from public.app_settings s where s.key = p_key), p_default)
$$;

-- True when the caller's JWT belongs to a live Auth session that is not idle and not too old.
-- Signing out (including "log out everywhere"), deactivation and Admin revocation delete the session,
-- which makes every following request fail immediately, even with a not-yet-expired access token.
create or replace function private.session_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from auth.sessions s
    left join public.session_activity a on a.session_id = s.id
    where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = auth.uid()
      and (s.not_after is null or s.not_after > now())
      and s.created_at > now() - make_interval(hours => private.setting_int('security', 'max_session_hours', 12))
      and coalesce(a.last_seen_at, s.created_at)
          > now() - make_interval(mins => private.setting_int('security', 'idle_timeout_minutes', 30))
  )
$$;

-- True when the user must present an MFA-verified (aal2) session: the role requires MFA,
-- or the user has enrolled an authenticator voluntarily (otherwise optional MFA would protect nothing).
create or replace function private.mfa_needed(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select r.mfa_required from public.profiles p join public.roles r on r.key = p.role_key where p.id = p_user_id), true)
      or exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified')
$$;

-- Active profile and, where needed, an MFA-verified (aal2) session.
create or replace function private.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
     and (not private.mfa_needed(auth.uid()) or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
     and private.session_ok()
$$;

-- Effective permission: Admin = everything; admin_only permissions only for Admin;
-- otherwise a per-user override wins over the role default.
create or replace function private.has_permission(p_key text)
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
    where p.id = auth.uid() and p.is_active
  ), false)
  and private.is_active_user()
$$;

create or replace function private.require_permission(p_key text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_permission(p_key) then
    raise exception 'You do not have permission for this action (%).', p_key using errcode = '42501';
  end if;
end;
$$;

create or replace function private.require_reason(p_reason text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  return trim(p_reason);
end;
$$;

-- Lets an RPC label the next audit entries with a business action name and reason (transaction-local).
create or replace function private.set_audit_context(p_action text, p_reason text default null)
returns void language sql volatile set search_path = '' as $$
  select set_config('cess.audit_action', coalesce(p_action, ''), true),
         set_config('cess.audit_reason', coalesce(p_reason, ''), true);
$$;

-- Optimistic locking + updated_at/updated_by stamping.
create or replace function private.bump_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.version    := old.version + 1;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% on % is not allowed: this history is append-only.', tg_op, tg_table_name
    using errcode = '42501';
end;
$$;

create or replace function private.forbid_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Deleting from % is not allowed. Deactivate the record instead.', tg_table_name
    using errcode = '42501';
end;
$$;

-- Generic audit trigger. TG_ARGV = key columns used to build entity_id.
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
      return null;  -- nothing meaningful changed
    end if;
  else
    v_prev := v_old;
    v_next := v_new;
  end if;

  v_row := coalesce(v_new, v_old);
  -- all trigger arguments except the last are key columns; the last one is the module name
  for i in 0 .. tg_nargs - 2 loop
    v_entity := v_entity || case when i > 0 then ':' else '' end || coalesce(v_row ->> tg_argv[i], '');
  end loop;

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
    (actor_id, actor_name, actor_role, source, action, module, entity_table, entity_id,
     previous_value, new_value, reason, session_id, aal)
  values
    (v_actor, v_name, v_role, v_source, v_action, coalesce(tg_argv[tg_nargs - 1], tg_table_name), tg_table_name, v_entity,
     v_prev, v_next, v_reason, nullif(v_claims ->> 'session_id', '')::uuid, v_claims ->> 'aal');
  return null;
end;
$$;

-- Create a profile for every new Auth user. New accounts start INACTIVE as Staff:
-- an Admin activates them through the invitation flow, so a user created any other way gets no access.
create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, role_key, is_active)
  values (new.id, coalesce(new.email, ''), left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120), 'staff', false)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function private.sync_auth_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = coalesce(new.email, '') where id = new.id;
  end if;
  return new;
end;
$$;

-- The last active Admin can never be demoted or deactivated.
create or replace function private.guard_last_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role_key = 'admin' and old.is_active and (new.role_key <> 'admin' or not new.is_active) then
    if not exists (
      select 1 from public.profiles p where p.role_key = 'admin' and p.is_active and p.id <> old.id
    ) then
      raise exception 'The last active Admin cannot be demoted or deactivated. Make another user Admin first.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- System cancellation reasons keep their meaning for scoring (label and active flag may change).
create or replace function private.guard_system_cancel_reason()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.is_system and (new.code <> old.code or new.vendor_related <> old.vendor_related
                        or new.vendor_subtype is distinct from old.vendor_subtype or not new.is_system) then
    raise exception 'Built-in cancellation reasons cannot change their vendor classification.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_auth_user();
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function private.sync_auth_email();

-- append-only history
create trigger activity_log_append_only before update or delete on public.activity_log
  for each row execute function private.forbid_change();
create trigger activity_log_no_truncate before truncate on public.activity_log
  for each statement execute function private.forbid_change();

-- version bumps
create trigger roles_version before update on public.roles for each row execute function private.bump_version();
create trigger profiles_version before update on public.profiles for each row execute function private.bump_version();
create trigger app_settings_version before update on public.app_settings for each row execute function private.bump_version();
create trigger work_categories_version before update on public.work_categories for each row execute function private.bump_version();
create trigger given_by_names_version before update on public.given_by_names for each row execute function private.bump_version();
create trigger cancel_reason_codes_version before update on public.cancel_reason_codes for each row execute function private.bump_version();

-- guards
create trigger profiles_last_admin before update on public.profiles for each row execute function private.guard_last_admin();
create trigger profiles_no_delete before delete on public.profiles for each row execute function private.forbid_delete();
create trigger work_categories_no_delete before delete on public.work_categories for each row execute function private.forbid_delete();
create trigger given_by_names_no_delete before delete on public.given_by_names for each row execute function private.forbid_delete();
create trigger cancel_reason_codes_no_delete before delete on public.cancel_reason_codes for each row execute function private.forbid_delete();
create trigger cancel_reason_codes_system before update on public.cancel_reason_codes for each row execute function private.guard_system_cancel_reason();
create trigger app_settings_no_delete before delete on public.app_settings for each row execute function private.forbid_delete();

-- audit (last trigger arg = module name, earlier args = key columns)
create trigger roles_audit after insert or update or delete on public.roles
  for each row execute function private.audit_row('key', 'users');
create trigger role_permissions_audit after insert or update or delete on public.role_permissions
  for each row execute function private.audit_row('role_key', 'permission_key', 'users');
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function private.audit_row('id', 'users');
create trigger user_permission_overrides_audit after insert or update or delete on public.user_permission_overrides
  for each row execute function private.audit_row('user_id', 'permission_key', 'users');
create trigger app_settings_audit after insert or update or delete on public.app_settings
  for each row execute function private.audit_row('key', 'settings');
create trigger work_categories_audit after insert or update or delete on public.work_categories
  for each row execute function private.audit_row('id', 'settings');
create trigger given_by_names_audit after insert or update or delete on public.given_by_names
  for each row execute function private.audit_row('id', 'settings');
create trigger cancel_reason_codes_audit after insert or update or delete on public.cancel_reason_codes
  for each row execute function private.audit_row('code', 'settings');

-- ---------------------------------------------------------------------------
-- 4. Seed data (reference data only; no users, no business data)
-- ---------------------------------------------------------------------------
select private.set_audit_context('system.seeded', 'Initial reference data (migration 20261102000100)');

insert into public.roles (key, label, description, mfa_required, sort_order) values
  ('admin',   'Admin',            'Full access: users, permissions, settings, payments, audit history.', true,  1),
  ('manager', 'Manager',          'Jobs, vendors, commitments, quality, reports. Payments are view-only by default.', true, 2),
  ('staff',   'Staff / Operator', 'Assigned or permitted operational job activities only.', false, 3);

insert into public.permissions (key, module, label, description, admin_only, sort_order) values
  ('jobs.view_all',          'jobs',        'View all jobs',                          '', false, 10),
  ('jobs.view_assigned',     'jobs',        'View jobs assigned to me or created by me', 'Staff default: only jobs where the user is the Assigned Staff User or the creator.', false, 11),
  ('jobs.create',            'jobs',        'Create jobs',                            '', false, 12),
  ('jobs.edit',              'jobs',        'Edit jobs (all fields)',                 '', false, 13),
  ('jobs.edit_assigned',     'jobs',        'Edit operational fields on my jobs',     '', false, 14),
  ('jobs.archive',           'jobs',        'Archive jobs',                           '', false, 15),
  ('jobs.cancel',            'jobs',        'Cancel jobs',                            'Requires a cancellation reason.', false, 16),
  ('assignments.change',     'jobs',        'Change or forward vendor assignment',    '', false, 17),
  ('commitments.change',     'jobs',        'Revise vendor commitment dates',         'Original commitment date is never overwritten.', false, 18),
  ('vendors.view',           'vendors',     'View vendor master',                     '', false, 20),
  ('vendors.manage',         'vendors',     'Add and edit vendors',                   '', false, 21),
  ('reliability.view',       'vendors',     'View vendor reliability scores',         '', false, 22),
  ('costcompare.view',       'vendors',     'View vendor cost comparison',            '', false, 23),
  ('quotations.manage',      'vendors',     'Add and edit vendor quotations',         '', false, 24),
  ('returns.record',         'quality',     'Record material returns',                '', false, 30),
  ('quality.manage',         'quality',     'Record quality inspections',             '', false, 31),
  ('payments.view',          'payments',    'View payments',                          '', false, 40),
  ('payments.add',           'payments',    'Add payments',                           'Admin only unless explicitly granted.', false, 41),
  ('payments.manage',        'payments',    'Adjust, reverse and correct payments',   'Admin only unless explicitly granted. History is never overwritten.', false, 42),
  ('whatsapp.send',          'communication','Open WhatsApp messages to vendors',     'Click-to-chat; the user presses Send.', false, 50),
  ('attachments.upload',     'attachments', 'Upload attachments',                     '', false, 60),
  ('attachments.download',   'attachments', 'Download attachments',                   '', false, 61),
  ('attachments.archive',    'attachments', 'Archive attachments',                    '', false, 62),
  ('reports.view',           'reports',     'View reports and dashboard analytics',   '', false, 70),
  ('reports.export',         'reports',     'Export reports and data to Excel/PDF',   '', false, 71),
  ('activity.view',          'admin',       'View activity and change history',       '', false, 80),
  ('settings.change',        'admin',       'Change settings and master lists',       'Security settings always require Admin.', false, 81),
  ('system.view',            'admin',       'View system health and backups',         '', false, 82),
  ('users.manage',           'admin',       'Manage users, roles and permissions',    'Admin only.', true, 90),
  ('backups.manage',         'admin',       'Run and restore backups',                'Admin only.', true, 91);

insert into public.role_permissions (role_key, permission_key)
select 'manager', unnest(array[
  'jobs.view_all', 'jobs.create', 'jobs.edit', 'jobs.cancel', 'assignments.change', 'commitments.change',
  'vendors.view', 'vendors.manage', 'reliability.view', 'costcompare.view', 'quotations.manage',
  'returns.record', 'quality.manage', 'payments.view', 'whatsapp.send',
  'attachments.upload', 'attachments.download', 'reports.view', 'reports.export'])
union all
select 'staff', unnest(array[
  'jobs.view_assigned', 'jobs.create', 'jobs.edit_assigned', 'vendors.view',
  'attachments.upload', 'attachments.download']);

-- Preserved from CESS_Machining_Job_Tracker.xlsx (SETTINGS sheet)
insert into public.work_categories (name, sort_order) values
  ('CNC Turning', 1), ('VMC Machining', 2), ('Wire EDM', 3), ('Grinding', 4), ('Laser Cutting & Bending', 5),
  ('Welding & Fabrication', 6), ('Heat Treatment', 7), ('Surface Finishing', 8), ('Drilling & Tapping', 9),
  ('Gear Cutting', 10), ('Others', 11);
insert into public.given_by_names (name, sort_order) values ('Samyak', 1), ('Vansh', 2), ('Sanjay', 3);

insert into public.cancel_reason_codes (code, label, vendor_related, vendor_subtype, is_system, sort_order) values
  ('vendor_missed_commitment', 'Vendor failed to meet delivery commitment',       true,  'delivery',            true, 1),
  ('vendor_refused',           'Vendor refused to complete work',                 true,  'refusal',             true, 2),
  ('vendor_incomplete',        'Vendor failed to complete assigned work',         true,  'incomplete',          true, 3),
  ('vendor_quality',           'Vendor caused machining or quality problems',     true,  'quality',             true, 4),
  ('vendor_repeated_delays',   'Vendor repeatedly failed to meet commitments',    true,  'repeated_commitment', true, 5),
  ('customer_cancelled',       'Customer cancelled the requirement',              false, null,                  true, 6),
  ('internal_planning',        'Internal planning changed',                       false, null,                  true, 7),
  ('production_change',        'Production requirement changed',                  false, null,                  true, 8),
  ('not_required',             'Part or job no longer required',                  false, null,                  true, 9),
  ('other_non_vendor',         'Other reason not related to vendor performance',  false, null,                  true, 10);

insert into public.app_settings (key, label, value) values
  ('company', 'Company information',
     '{"name": "", "address": "", "gstin": "", "phone": "", "email": ""}'),
  ('localization', 'Localization and financial year',
     '{"currency": "INR", "timezone": "Asia/Kolkata", "date_format": "dd-MMM-yyyy", "fy_start_month": 4}'),
  ('security', 'Session security',
     '{"idle_timeout_minutes": 30, "max_session_hours": 12}'),
  ('jobs', 'Job status thresholds',
     '{"due_soon_days": 3, "long_pending_days": 10}'),
  ('reliability', 'Vendor reliability score',
     '{"weights": {"on_time": 30, "quality": 25, "delay": 15, "stability": 10, "completion_time": 10, "vendor_cancellation": 10},
       "min_eligible_jobs": 5, "min_factors": 3, "delay_cap_days": 14, "stability_revisions_cap": 2,
       "labels": {"excellent": 85, "good": 70, "average": 50}}'),
  ('reminders', 'Reminder schedule',
     '{"enabled": true, "days_before": [3, 1], "on_due_date": true, "overdue_after_days": 1,
       "repeat_daily_when_overdue": true, "run_time_ist": "09:00", "whatsapp_auto": false}'),
  ('weekly_report', 'Weekly management report',
     '{"enabled": true, "weekday": 1, "run_time_ist": "08:00", "email_delivery": false}'),
  ('attachments', 'Attachments',
     '{"max_file_mb": 50, "allowed_extensions": ["pdf", "xlsx", "xls", "csv", "dxf", "dwg", "step", "stp", "sldprt", "sldasm", "jpg", "jpeg", "png"]}'),
  ('whatsapp', 'WhatsApp',
     '{"default_country_code": "+91", "mode": "click_to_chat"}');

select private.set_audit_context(null, null);

-- ---------------------------------------------------------------------------
-- 5. Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.roles                     enable row level security;
alter table public.permissions               enable row level security;
alter table public.role_permissions          enable row level security;
alter table public.profiles                  enable row level security;
alter table public.user_permission_overrides enable row level security;
alter table public.session_activity          enable row level security;
alter table public.activity_log              enable row level security;
alter table public.app_settings              enable row level security;
alter table public.work_categories           enable row level security;
alter table public.given_by_names            enable row level security;
alter table public.cancel_reason_codes       enable row level security;
alter table public.backup_runs               enable row level security;

revoke all on public.roles, public.permissions, public.role_permissions, public.profiles,
              public.user_permission_overrides, public.session_activity, public.activity_log,
              public.app_settings, public.work_categories, public.given_by_names,
              public.cancel_reason_codes, public.backup_runs
  from anon, authenticated;
revoke update, delete, truncate on public.activity_log from service_role;

-- read access (writes to these go through checked RPCs only)
grant select on public.roles, public.permissions, public.role_permissions, public.profiles,
                public.user_permission_overrides, public.activity_log, public.app_settings,
                public.work_categories, public.given_by_names, public.cancel_reason_codes,
                public.backup_runs
  to authenticated;
-- master lists may be edited directly (RLS + audit trigger); never deleted
grant insert, update on public.work_categories, public.given_by_names, public.cancel_reason_codes to authenticated;

create policy roles_read on public.roles for select to authenticated
  using ((select private.is_active_user()));
create policy permissions_read on public.permissions for select to authenticated
  using ((select private.is_active_user()));
create policy role_permissions_read on public.role_permissions for select to authenticated
  using ((select private.is_active_user()));

create policy profiles_read on public.profiles for select to authenticated
  using ((id = (select auth.uid()) and (select private.is_active_user()))
         or (select private.has_permission('users.manage')));

create policy overrides_read on public.user_permission_overrides for select to authenticated
  using ((user_id = (select auth.uid()) and (select private.is_active_user()))
         or (select private.has_permission('users.manage')));

create policy activity_read on public.activity_log for select to authenticated
  using ((select private.has_permission('activity.view')));

create policy settings_read on public.app_settings for select to authenticated
  using ((select private.is_active_user()));

create policy backup_runs_read on public.backup_runs for select to authenticated
  using ((select private.has_permission('system.view')));

create policy work_categories_read on public.work_categories for select to authenticated
  using ((select private.is_active_user()));
create policy work_categories_insert on public.work_categories for insert to authenticated
  with check ((select private.has_permission('settings.change')));
create policy work_categories_update on public.work_categories for update to authenticated
  using ((select private.has_permission('settings.change')))
  with check ((select private.has_permission('settings.change')));

create policy given_by_read on public.given_by_names for select to authenticated
  using ((select private.is_active_user()));
create policy given_by_insert on public.given_by_names for insert to authenticated
  with check ((select private.has_permission('settings.change')));
create policy given_by_update on public.given_by_names for update to authenticated
  using ((select private.has_permission('settings.change')))
  with check ((select private.has_permission('settings.change')));

create policy cancel_reasons_read on public.cancel_reason_codes for select to authenticated
  using ((select private.is_active_user()));
create policy cancel_reasons_insert on public.cancel_reason_codes for insert to authenticated
  with check ((select private.has_permission('settings.change')) and not is_system);
create policy cancel_reasons_update on public.cancel_reason_codes for update to authenticated
  using ((select private.has_permission('settings.change')))
  with check ((select private.has_permission('settings.change')));

-- session_activity: no direct access at all (maintained by touch_session()).

-- private helpers must be executable by authenticated users because RLS policies call them.
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
