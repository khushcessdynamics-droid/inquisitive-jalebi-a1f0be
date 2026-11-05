import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from "./permissions";

import { readdirSync } from "node:fs";
const dir = new URL("../../../supabase/migrations/", import.meta.url);
const migration = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, dir), "utf8"))
  .join("\n");

describe("permission catalogue matches the database migration", () => {
  it("every key is seeded and nothing extra exists", () => {
    const seeded = [...migration.matchAll(/^\s*\('([a-z_]+\.[a-z_]+)',\s*'[a-z]+',/gm)].map((m) => m[1]);
    expect([...seeded].sort()).toEqual([...PERMISSION_KEYS].sort());
  });
  it("admin-only permissions are marked admin_only in the seed", () => {
    for (const key of ADMIN_ONLY_PERMISSIONS) {
      expect(migration).toMatch(new RegExp(`\\('${key.replace(".", "\\.")}',[^\\n]*true,\\s*\\d+\\)`));
    }
  });
  it("Manager can view but not add or manage payments by default (approved rule)", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain("payments.view");
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain("payments.add");
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain("payments.manage");
    expect(DEFAULT_ROLE_PERMISSIONS.staff).not.toContain("payments.view");
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain("users.manage");
  });
});
