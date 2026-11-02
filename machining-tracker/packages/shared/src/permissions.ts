// Permission and role keys. The database (public.permissions / public.roles) is the source of truth;
// these constants give the frontend type-safe names. A unit test checks they match the migration seed.

export const ROLE_KEYS = ["admin", "manager", "staff"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSION_KEYS = [
  "jobs.view_all",
  "jobs.view_assigned",
  "jobs.create",
  "jobs.edit",
  "jobs.edit_assigned",
  "jobs.archive",
  "jobs.cancel",
  "assignments.change",
  "commitments.change",
  "vendors.view",
  "vendors.manage",
  "reliability.view",
  "costcompare.view",
  "quotations.manage",
  "returns.record",
  "quality.manage",
  "payments.view",
  "payments.add",
  "payments.manage",
  "whatsapp.send",
  "attachments.upload",
  "attachments.download",
  "attachments.archive",
  "reports.view",
  "reports.export",
  "activity.view",
  "settings.change",
  "data.import",
  "system.view",
  "users.manage",
  "backups.manage",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Never grantable to non-Admin roles or users (privilege-escalation protection). */
export const ADMIN_ONLY_PERMISSIONS: readonly PermissionKey[] = ["users.manage", "backups.manage"];

/** Default grants seeded by the migration (Admin implicitly has every permission). */
export const DEFAULT_ROLE_PERMISSIONS: Record<Exclude<RoleKey, "admin">, readonly PermissionKey[]> = {
  manager: [
    "jobs.view_all",
    "jobs.create",
    "jobs.edit",
    "jobs.cancel",
    "assignments.change",
    "commitments.change",
    "vendors.view",
    "vendors.manage",
    "reliability.view",
    "costcompare.view",
    "quotations.manage",
    "returns.record",
    "quality.manage",
    "payments.view",
    "whatsapp.send",
    "attachments.upload",
    "attachments.download",
    "reports.view",
    "reports.export",
  ],
  staff: ["jobs.view_assigned", "jobs.create", "jobs.edit_assigned", "vendors.view", "attachments.upload", "attachments.download"],
};

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
