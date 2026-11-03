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

export interface JobRegisterRow {
  id: string;
  job_no: string;
  part_label: string;
  description: string;
  qty_sent: number | null;
  remarks: string;
  source: "app" | "excel_import";
  version: number;
  category_id: string;
  category_name: string;
  given_by_id: string | null;
  given_by_name: string | null;
  assigned_staff_id: string | null;
  assigned_staff_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  closed_at: string | null;
  closed_on: string | null;
  closed_reason: string | null;
  archived_at: string | null;
  assignment_id: string | null;
  sequence_no: number | null;
  assignment_version: number | null;
  assignment_state: "open" | "completed" | "cancelled" | null;
  vendor_id: string | null;
  vendor_name: string | null;
  date_given: string | null;
  assignment_qty: number | null;
  amount: number | null;
  original_commitment_date: string | null;
  current_commitment_date: string | null;
  return_date: string | null;
  cancelled_on: string | null;
  assignment_count: number;
  status: string;
  days_since_given: number | null;
  remaining_days: number | null;
  delay_days: number | null;
  delay_days_current: number | null;
  long_pending: boolean | null;
  financial_year: string | null;
  revision_count: number;
  qty_received: number;
  qty_accepted: number;
  qty_rejected: number;
  qty_rework: number;
  qty_awaiting_inspection: number;
  qty_with_vendor: number | null;
}

export interface AssignmentRow {
  id: string;
  job_id: string;
  sequence_no: number;
  vendor_id: string;
  dispatched_on: string;
  qty_sent: number | null;
  amount: number | null;
  original_commitment_date: string | null;
  current_commitment_date: string | null;
  state: "open" | "completed" | "cancelled";
  completed_on: string | null;
  cancelled_on: string | null;
  cancel_reason_code: string | null;
  cancel_reason_text: string | null;
  cancelled_by: string | null;
  previous_assignment_id: string | null;
  remarks: string;
  created_at: string;
  version: number;
  invoice_no?: string | null;
  invoice_date?: string | null;
}

export interface VendorRow {
  id: string;
  vendor_code: string;
  name: string;
  company_name: string;
  contact_person: string;
  mobile: string;
  wa_country_code: string;
  wa_number: string;
  email: string;
  address: string;
  gst_no: string;
  payment_terms: string;
  remarks: string;
  is_active: boolean;
  version: number;
  vendor_categories?: Array<{ work_category_id: string }>;
}

export interface AttachmentRow {
  id: string;
  job_id: string;
  assignment_id: string | null;
  storage_path: string;
  file_name: string;
  extension: string;
  mime_type: string | null;
  size_bytes: number;
  uploaded_by: string;
  uploaded_at: string;
  archived_at: string | null;
  archive_reason: string | null;
}
