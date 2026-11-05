import { describe, expect, it } from "vitest";
import { commitmentOutcome, lateness, recentFinancialYears, scoreLabel } from "./commitments";

describe("commitment outcome (Example 2: original 05-Nov, revised 08-Nov)", () => {
  const base = { original: "2026-11-05", current: "2026-11-08", completedOn: null, cancelledOn: null };
  it("open job on 10-Nov: 5 days late vs original, 2 days late vs the revised date", () => {
    expect(commitmentOutcome({ ...base, state: "open", today: "2026-11-10" })).toEqual({ kind: "open", remaining: -2, vsOriginal: 5, vsLatest: 2 });
  });
  it("open job on 06-Nov: overdue against the original promise but still within the revised date", () => {
    expect(commitmentOutcome({ ...base, state: "open", today: "2026-11-06" })).toEqual({ kind: "open", remaining: 2, vsOriginal: 1, vsLatest: -2 });
  });
  it("returned on 08-Nov: 3 days late vs original, on time vs the revised date", () => {
    expect(commitmentOutcome({ ...base, state: "completed", completedOn: "2026-11-08", today: "2026-11-20" })).toEqual({
      kind: "returned", on: "2026-11-08", vsOriginal: 3, vsLatest: 0,
    });
  });
  it("no commitment and cancelled jobs", () => {
    expect(commitmentOutcome({ ...base, original: null, current: null, state: "open", today: "2026-11-10" })).toEqual({ kind: "no_commitment" });
    expect(commitmentOutcome({ ...base, state: "cancelled", cancelledOn: "2026-11-07", today: "2026-11-10" })).toEqual({ kind: "cancelled", on: "2026-11-07" });
  });
  it("words", () => {
    expect([lateness(3), lateness(1), lateness(0), lateness(-2)]).toEqual(["3 days late", "1 day late", "on time", "2 days early"]);
  });
});

describe("financial years and score labels", () => {
  it("lists the current FY first; April starts a new year", () => {
    expect(recentFinancialYears("2026-11-03", 3)).toEqual(["2026-27", "2025-26", "2024-25"]);
    expect(recentFinancialYears("2026-03-31", 1)).toEqual(["2025-26"]);
    expect(recentFinancialYears("2099-04-01", 1)).toEqual(["2099-00"]);
  });
  it("uses the configured thresholds", () => {
    const l = { excellent: 85, good: 70, average: 50 };
    expect([scoreLabel(85, l), scoreLabel(84.9, l), scoreLabel(70, l), scoreLabel(50, l), scoreLabel(49.9, l)]).toEqual([
      "Excellent", "Good", "Good", "Average", "Needs Improvement",
    ]);
  });
});
