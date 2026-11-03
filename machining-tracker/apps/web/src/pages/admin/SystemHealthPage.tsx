import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { formatDateTimeIST } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { useDateFormat } from "../../hooks/data";
import { Alert, Badge, Button, Card, PageHeader, Spinner, Table, cx, td, th } from "../../components/ui";
// Supabase Free plan limits, checked on 2026-11-02 against supabase.com/pricing and the Supabase docs.
import { FREE_DB_BYTES, FREE_STORAGE_BYTES, JOB_LABELS, healthWarnings, type ScheduledJob } from "../../lib/healthWarnings";

interface BackupRun {
  finished_at: string | null;
  started_at: string;
  status: string;
  archive_name: string | null;
  error: string | null;
}
interface Health {
  checked_at: string;
  today_ist: string;
  database_ok: boolean;
  database_size_bytes: number;
  storage_size_bytes: number | null;
  storage_object_count: number | null;
  auth_users: number;
  active_users: number;
  live_sessions: number;
  schema_version: string | null;
  table_rows: Record<string, number>;
  activity_log_rows: number;
  last_verified_backup: BackupRun | null;
  last_failed_backup: BackupRun | null;
  scheduled_jobs: ScheduledJob[] | null;
  reminder_engine: { enabled: boolean; run_time_ist: string | null; last_run_date: string | null; last_run_at: string | null; reminders_created: number | null } | null;
  last_weekly_report: { period_start: string; period_end: string; kind: string; generated_at: string } | null;
}

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function Usage({ label, used, limit }: { label: string; used: number | null; limit: number }) {
  const pct = used === null ? 0 : Math.min(100, (used / limit) * 100);
  const tone = pct >= 80 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium">
          {bytes(used)} of {bytes(limit)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-100">
        <div className={cx("h-2 rounded-full", tone)} style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
      {pct >= 80 && <p className="mt-1 text-xs text-red-600">Close to the free-plan limit. Plan an archive or upgrade before it is reached.</p>}
    </div>
  );
}

export function SystemHealthPage() {
  const dateFormat = useDateFormat();
  const q = useQuery({
    queryKey: ["system-health"],
    queryFn: async () => unwrap(await supabase.rpc("system_health")) as Health,
    refetchInterval: 60_000,
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) {
    return (
      <>
        <PageHeader title="System Health" />
        <Alert tone="error" title="Database check failed">
          {toAppError(q.error).message}
        </Alert>
      </>
    );
  }
  const h = q.data!;
  const warnings = healthWarnings(h);
  return (
    <>
      <PageHeader
        title="System Health"
        description={`Checked ${formatDateTimeIST(h.checked_at, dateFormat)}`}
        actions={
          <Button variant="secondary" onClick={() => void q.refetch()} loading={q.isFetching}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Needs attention" className="lg:col-span-2">
          {warnings.length === 0 ? (
            <p className="text-sm">
              <Badge tone="green">OK</Badge> Backups, space and scheduled jobs look normal.
            </p>
          ) : (
            <ul className="space-y-2" aria-label="Problems found">
              {warnings.map((w) => (
                <li key={w.text}>
                  <Alert tone={w.level === "critical" ? "error" : "warning"}>{w.text}</Alert>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Status">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Database connection</dt>
              <dd>{h.database_ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Error</Badge>}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Schema version</dt>
              <dd className="font-mono text-xs">{h.schema_version ?? "unknown"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Users (active / total)</dt>
              <dd>
                {h.active_users} / {h.auth_users}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Live sessions</dt>
              <dd>{h.live_sessions}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Activity history entries</dt>
              <dd>{h.activity_log_rows}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Free-plan usage">
          <div className="space-y-4">
            <Usage label="Database" used={h.database_size_bytes} limit={FREE_DB_BYTES} />
            <Usage label={`File storage (${h.storage_object_count ?? 0} files)`} used={h.storage_size_bytes} limit={FREE_STORAGE_BYTES} />
            <p className="text-xs text-slate-500">
              Supabase Free: 500 MB database, 1 GB files, 5 GB egress per month. Projects with no activity for 7 days are paused (restorable from the Supabase
              dashboard).
            </p>
          </div>
        </Card>
        <Card title="Backups" className="lg:col-span-2">
          {h.last_verified_backup ? (
            <p className="text-sm">
              <Badge tone="green">Verified</Badge> Last verified backup finished {formatDateTimeIST(h.last_verified_backup.finished_at, dateFormat)} (
              {h.last_verified_backup.archive_name}).
            </p>
          ) : (
            <Alert tone="warning" title="No verified backup recorded yet">
              Supabase Free does not include automatic backups. The local backup tool for your Windows PC records each verified backup here once it is set up.
            </Alert>
          )}
          {h.last_failed_backup && (
            <div className="mt-3">
              <Alert tone="error" title={`Last failed backup: ${formatDateTimeIST(h.last_failed_backup.started_at, dateFormat)}`}>
                {h.last_failed_backup.error}
              </Alert>
            </div>
          )}
        </Card>
        <Card title="Scheduled jobs (database scheduler)" className="lg:col-span-2">
          {h.scheduled_jobs === null ? (
            <Alert tone="error">The database scheduler is not available.</Alert>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Job</th>
                  <th className={th}>Last run</th>
                  <th className={th}>Result</th>
                  <th className={th}>Runs / failed (7 days)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {h.scheduled_jobs.map((j) => (
                  <tr key={j.name}>
                    <td className={td}>
                      {JOB_LABELS[j.name] ?? j.name}
                      {!j.active && (
                        <span className="ml-2">
                          <Badge tone="red">Off</Badge>
                        </span>
                      )}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{j.last_start ? formatDateTimeIST(j.last_start, dateFormat) : "not yet"}</td>
                    <td className={td}>
                      {j.last_status === null ? "—" : j.last_status === "succeeded" ? <Badge tone="green">OK</Badge> : <Badge tone="red">{j.last_status}</Badge>}
                      {j.last_message && <p className="mt-1 text-xs text-red-700">{j.last_message}</p>}
                    </td>
                    <td className={td}>
                      {j.runs_7d} / {j.failures_7d}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Reminders</dt>
              <dd>
                {!h.reminder_engine?.enabled
                  ? "Switched off in Settings"
                  : h.reminder_engine.last_run_at
                    ? `Last run ${formatDateTimeIST(h.reminder_engine.last_run_at, dateFormat)}; daily at ${h.reminder_engine.run_time_ist ?? "09:00"} IST`
                    : `Not run yet; daily at ${h.reminder_engine.run_time_ist ?? "09:00"} IST`}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Latest weekly report</dt>
              <dd>
                {h.last_weekly_report
                  ? `${h.last_weekly_report.period_start} to ${h.last_weekly_report.period_end} (${h.last_weekly_report.kind}), made ${formatDateTimeIST(h.last_weekly_report.generated_at, dateFormat)}`
                  : "None yet"}
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Rows per table" className="lg:col-span-2">
          <Table>
            <thead>
              <tr>
                <th className={th}>Table</th>
                <th className={th}>Rows (estimate)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(h.table_rows).map(([t, n]) => (
                <tr key={t}>
                  <td className={`${td} font-mono text-xs`}>{t}</td>
                  <td className={td}>{n}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
