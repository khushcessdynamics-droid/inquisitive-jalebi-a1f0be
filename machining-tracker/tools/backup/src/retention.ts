// Decides which old backups may be deleted. Pure function, unit-tested.
// Safety rules (always applied, whatever the settings):
//   1. The newest VERIFIED backup is never deleted.
//   2. A deletion never leaves fewer than `minVerified` verified backups.
//   3. Pre-restore / pre-migration safety backups are kept for at least 90 days.
//   4. Unverified or failed files are kept for 7 days for diagnosis, then removed.

export interface BackupInfo {
  name: string;
  createdAt: string; // ISO timestamp
  status: "verified" | "unverified" | "failed";
  kind: "scheduled" | "manual" | "pre_restore" | "pre_migration";
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
  minVerified: number;
}

export interface RetentionPlan {
  keep: Array<{ name: string; reason: string }>;
  remove: Array<{ name: string; reason: string }>;
}

const DAY = 86_400_000;

function istDate(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}
function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function planRetention(backups: BackupInfo[], policy: RetentionPolicy, now: Date = new Date()): RetentionPlan {
  const keep = new Map<string, string>();
  const sorted = [...backups].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); // newest first
  const verified = sorted.filter((b) => b.status === "verified");

  if (verified[0]) keep.set(verified[0].name, "newest verified backup");

  const bucket = (label: string, count: number, keyOf: (b: BackupInfo) => string) => {
    const seen = new Set<string>();
    for (const b of verified) {
      const k = keyOf(b);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > count) break;
      if (!keep.has(b.name)) keep.set(b.name, `${label} ${k}`);
    }
  };
  bucket("daily", policy.daily, (b) => istDate(b.createdAt));
  bucket("weekly", policy.weekly, (b) => isoWeek(istDate(b.createdAt)));
  bucket("monthly", policy.monthly, (b) => istDate(b.createdAt).slice(0, 7));

  for (const b of sorted) {
    const age = now.getTime() - Date.parse(b.createdAt);
    if ((b.kind === "pre_restore" || b.kind === "pre_migration") && age < 90 * DAY && !keep.has(b.name)) {
      keep.set(b.name, "safety backup (kept 90 days)");
    }
    if (b.status !== "verified" && age < 7 * DAY && !keep.has(b.name)) {
      keep.set(b.name, `${b.status} (kept 7 days for diagnosis)`);
    }
  }

  // Never go below the minimum number of verified backups: keep the newest extra ones.
  let verifiedKept = verified.filter((b) => keep.has(b.name)).length;
  for (const b of verified) {
    if (verifiedKept >= policy.minVerified) break;
    if (!keep.has(b.name)) {
      keep.set(b.name, "minimum number of verified backups");
      verifiedKept++;
    }
  }

  const plan: RetentionPlan = { keep: [], remove: [] };
  for (const b of sorted) {
    const reason = keep.get(b.name);
    if (reason) plan.keep.push({ name: b.name, reason });
    else plan.remove.push({ name: b.name, reason: b.status === "verified" ? "older than the retention period" : `old ${b.status} backup` });
  }
  return plan;
}
