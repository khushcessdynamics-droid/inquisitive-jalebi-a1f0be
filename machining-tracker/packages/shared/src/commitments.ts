// Pure helpers for commitment dates (used by the job timeline; the database applies the same rules).
import { daysBetween, financialYear } from "./dates";

export interface CommitmentOutcomeInput {
  state: "open" | "completed" | "cancelled";
  original: string | null;
  current: string | null;
  completedOn: string | null;
  cancelledOn: string | null;
  today: string;
}

export type CommitmentOutcome =
  | { kind: "no_commitment" }
  | { kind: "cancelled"; on: string | null }
  | { kind: "returned"; on: string; vsOriginal: number; vsLatest: number }
  | { kind: "open"; remaining: number; vsOriginal: number; vsLatest: number };

/**
 * Where an assignment stands against its ORIGINAL and LATEST committed dates.
 * vsOriginal / vsLatest: days late (positive) or early/on time (zero or negative), using the return date for
 * returned jobs and today for open jobs. remaining: days until the latest committed date (negative = overdue).
 */
export function commitmentOutcome(a: CommitmentOutcomeInput): CommitmentOutcome {
  if (a.state === "cancelled") return { kind: "cancelled", on: a.cancelledOn };
  if (!a.original || !a.current) return { kind: "no_commitment" };
  if (a.state === "completed" && a.completedOn) {
    return { kind: "returned", on: a.completedOn, vsOriginal: daysBetween(a.original, a.completedOn), vsLatest: daysBetween(a.current, a.completedOn) };
  }
  return {
    kind: "open",
    remaining: daysBetween(a.today, a.current),
    vsOriginal: daysBetween(a.original, a.today),
    vsLatest: daysBetween(a.current, a.today),
  };
}

/** "3 days late", "on time", "2 days early" */
export function lateness(days: number): string {
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} late`;
  if (days === 0) return "on time";
  return `${-days} day${days === -1 ? "" : "s"} early`;
}

/** The current and previous financial years, newest first (e.g. ["2026-27", "2025-26", ...]). */
export function recentFinancialYears(today: string, count: number): string[] {
  const start = Number(financialYear(today).label.slice(0, 4));
  return Array.from({ length: count }, (_, i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, "0")}`);
}

export type ScoreLabel = "Excellent" | "Good" | "Average" | "Needs Improvement";

/** Same thresholds as the database (Settings > Reliability score). */
export function scoreLabel(score: number, labels: { excellent: number; good: number; average: number }): ScoreLabel {
  if (score >= labels.excellent) return "Excellent";
  if (score >= labels.good) return "Good";
  if (score >= labels.average) return "Average";
  return "Needs Improvement";
}
