import { describe, expect, it } from "vitest";
import { daysBetween, financialYear, formatDate, formatDateTimeIST, isIsoDate, todayIST } from "./dates";

describe("todayIST", () => {
  it("uses the Indian calendar date, not UTC", () => {
    // 2026-11-04 20:00 UTC is already 5 November 01:30 in India
    expect(todayIST(new Date("2026-11-04T20:00:00Z"))).toBe("2026-11-05");
    // 2026-11-04 18:29 UTC is still 4 November 23:59 in India
    expect(todayIST(new Date("2026-11-04T18:29:59Z"))).toBe("2026-11-04");
  });
});

describe("daysBetween", () => {
  it("counts calendar days (job given 1 Nov, committed 5 Nov = 4 days)", () => {
    expect(daysBetween("2026-11-01", "2026-11-05")).toBe(4);
    expect(daysBetween("2026-11-05", "2026-11-01")).toBe(-4);
    expect(daysBetween("2027-02-28", "2027-03-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2); // leap year
  });
  it("rejects invalid dates", () => {
    expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow();
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-11-02")).toBe(true);
  });
});

describe("financialYear (April to March)", () => {
  it("assigns January-March to the previous FY", () => {
    expect(financialYear("2027-03-31")).toEqual({ label: "2026-27", start: "2026-04-01", end: "2027-03-31" });
    expect(financialYear("2026-04-01").label).toBe("2026-27");
    expect(financialYear("2026-11-02").label).toBe("2026-27");
    expect(financialYear("2099-12-31").label).toBe("2099-00");
  });
});

describe("formatDate", () => {
  it("supports the configurable formats (Excel tracker used dd-mmm-yyyy)", () => {
    expect(formatDate("2026-11-02", "dd-MMM-yyyy")).toBe("02-Nov-2026");
    expect(formatDate("2026-11-02", "dd/MM/yyyy")).toBe("02/11/2026");
    expect(formatDate("2026-11-02", "dd-MM-yyyy")).toBe("02-11-2026");
    expect(formatDate("2026-11-02", "yyyy-MM-dd")).toBe("2026-11-02");
    expect(formatDate(null)).toBe("");
  });
  it("shows timestamps in IST", () => {
    expect(formatDateTimeIST("2026-11-02T10:30:00Z")).toBe("02-Nov-2026 16:00 IST");
  });
});
