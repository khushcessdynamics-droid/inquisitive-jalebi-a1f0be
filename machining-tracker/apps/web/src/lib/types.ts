import type { PermissionKey, RoleKey } from "@cess/shared";

export type AccessStatus = "anonymous" | "no_profile" | "inactive" | "session_expired" | "mfa_required" | "ok";

export interface Access {
  status: AccessStatus;
  user_id?: string;
  email?: string;
  full_name?: string;
  role_key?: RoleKey;
  role_label?: string;
  mfa_required?: boolean;
  mfa_enrolled?: boolean;
  aal?: string;
  profile_version?: number;
  permissions?: PermissionKey[];
  idle_timeout_minutes?: number;
  max_session_hours?: number;
}

export interface SettingRow<T = Record<string, unknown>> {
  key: string;
  label: string;
  value: T;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

export interface MasterRow {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  version: number;
}

export interface CancelReasonRow {
  code: string;
  label: string;
  vendor_related: boolean;
  vendor_subtype: string | null;
  is_active: boolean;
  is_system: boolean;
  sort_order: number;
  version: number;
}

export interface AdminUserRow {
  id: string;
  email: string;
  full_name: string;
  role_key: RoleKey;
  is_active: boolean;
  version: number;
  created_at: string;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  invited_at: string | null;
  mfa_enabled: boolean;
  active_sessions: number;
  override_count: number;
}

export interface ActivityRow {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  source: string;
  action: string;
  module: string;
  entity_table: string | null;
  entity_id: string | null;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
}
