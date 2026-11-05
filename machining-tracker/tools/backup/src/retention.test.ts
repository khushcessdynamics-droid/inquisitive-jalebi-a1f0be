import { describe, expect, it } from "vitest";
import { planRetention, type BackupInfo } from "./retention.ts";

const policy = { daily: 3, weekly: 2, monthly: 2, minVerified: 3 };
const now = new Date("2026-11-30T12:00:00Z");

function daily(n: number, status: BackupInfo["status"] = "verified"): BackupInfo[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getTime() - i * 86_400_000);
    return { name: `b${i}`, createdAt: d.toISOString(), status, kind: "scheduled" as const };
  });
}

describe("retention planning", () => {
  it("never deletes the only backup, even an old one", () => {
    const plan = planRetention([{ name: "only", createdAt: "2020-01-01T00:00:00Z", status: "verified", kind: "manual" }], policy, now);
    expect(plan.remove).toEqual([]);
  });

  it("keeps the newest verified backup even when newer backups failed", () => {
    const list: BackupInfo[] = [
      { name: "failed-new", createdAt: "2026-11-30T10:00:00Z", status: "failed", kind: "scheduled" },
      { name: "good-old", createdAt: "2025-01-01T10:00:00Z", status: "verified", kind: "scheduled" },
    ];
    const plan = planRetention(list, policy, now);
    expect(plan.keep.map((k) => k.name)).toContain("good-old");
  });

  it("keeps daily, weekly and monthly backups and removes the rest", () => {
    const plan = planRetention(daily(90), policy, now);
    const kept = plan.keep.map((k) => k.name);
    expect(kept).toEqual(expect.arrayContaining(["b0", "b1", "b2"]));
    expect(kept.length).toBeLessThan(10);
    expect(plan.remove.length).toBe(90 - kept.length);
  });

  it("never keeps fewer verified backups than the minimum", () => {
    const plan = planRetention(daily(10), { daily: 0, weekly: 0, monthly: 0, minVerified: 4 }, now);
    expect(plan.keep.length).toBe(4);
  });

  it("removes old failed files but keeps recent ones for diagnosis", () => {
    const list: BackupInfo[] = [
      ...daily(3),
      { name: "failed-recent", createdAt: "2026-11-29T00:00:00Z", status: "failed", kind: "scheduled" },
      { name: "failed-old", createdAt: "2026-10-01T00:00:00Z", status: "failed", kind: "scheduled" },
    ];
    const plan = planRetention(list, policy, now);
    expect(plan.keep.map((k) => k.name)).toContain("failed-recent");
    expect(plan.remove.map((k) => k.name)).toContain("failed-old");
  });

  it("keeps safety backups taken before a restore for 90 days", () => {
    const list: BackupInfo[] = [...daily(3), { name: "pre", createdAt: "2026-10-15T00:00:00Z", status: "verified", kind: "pre_restore" }];
    expect(planRetention(list, { daily: 1, weekly: 0, monthly: 0, minVerified: 1 }, now).keep.map((k) => k.name)).toContain("pre");
  });
});
