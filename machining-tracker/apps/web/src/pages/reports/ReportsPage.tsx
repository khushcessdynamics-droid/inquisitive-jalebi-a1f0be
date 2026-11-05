import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, FileSpreadsheet, PlusCircle } from "lucide-react";
import { formatDate, formatDateTimeIST, todayIST } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { buildSections, downloadReportExcel, downloadReportPdf, reportTitle, type WeeklyReport } from "../../lib/weeklyReport";
import { useDateFormat, useSettings } from "../../hooks/data";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, Table, cx, td, th } from "../../components/ui";

interface ListRow {
  id: string;
  period_start: string;
  period_end: string;
  kind: "scheduled" | "manual";
  generated_at: string;
  generated_by_name: string | null;
  new_jobs: number;
  completed: number;
  overdue_now: number;
}

function lastMonday(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow - 7);
  return d.toISOString().slice(0, 10);
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const qc = useQueryClient();
  const dateFormat = useDateFormat();
  const [start, setStart] = useState(lastMonday(todayIST()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["weekly-reports"], queryFn: async () => unwrap(await supabase.rpc("list_weekly_reports")) as ListRow[] });
  const end = useMemo(() => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  }, [start]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = unwrap(await supabase.rpc("generate_weekly_report", { p_start: start })) as { id: string };
      await qc.invalidateQueries({ queryKey: ["weekly-reports"] });
      setParams({ id: r.id });
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  if (selected) return <ReportView id={selected} onBack={() => setParams({})} />;
  return (
    <>
      <PageHeader title="Weekly Reports" description="Made automatically every week (Settings > Weekly report) from the recorded data, and on request for any past week. Kept permanently." />
      <Card title="Make a report now">
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
          <Field label="Week starting" htmlFor="wr-start" hint={`Covers ${formatDate(start, dateFormat)} to ${formatDate(end, dateFormat)}`}>
            <Input id="wr-start" type="date" value={start} max={todayIST()} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <p className="text-sm text-slate-600">The week must have ended. Making a report again for the same week keeps the earlier one in the history.</p>
          <Button loading={busy} onClick={generate}>
            <PlusCircle className="h-4 w-4" /> Make report
          </Button>
        </div>
        {error && <div className="mt-3"><Alert tone="error">{error}</Alert></div>}
      </Card>
      <div className="mt-4">
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <Alert tone="error">{toAppError(list.error).message}</Alert>
        ) : !list.data?.length ? (
          <EmptyState title="No reports yet">The first automatic report is made on the next scheduled day.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Week</th>
                <th className={th}>Made</th>
                <th className={`${th} text-right`}>New jobs</th>
                <th className={`${th} text-right`}>Completed</th>
                <th className={`${th} text-right`}>Overdue (at the time)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <Link to={`/reports?id=${r.id}`} className="font-medium text-brand-700 hover:underline">
                      {formatDate(r.period_start, dateFormat)} to {formatDate(r.period_end, dateFormat)}
                    </Link>
                  </td>
                  <td className={td}>
                    {formatDateTimeIST(r.generated_at, dateFormat)} {r.kind === "scheduled" ? <Badge tone="blue">automatic</Badge> : <Badge>by {r.generated_by_name}</Badge>}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{r.new_jobs}</td>
                  <td className={`${td} text-right tabular-nums`}>{r.completed}</td>
                  <td className={`${td} text-right tabular-nums`}>{r.overdue_now}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}

function ReportView({ id, onBack }: { id: string; onBack: () => void }) {
  const dateFormat = useDateFormat();
  const settings = useSettings();
  const company = (settings.data?.company?.value as { name?: string } | undefined)?.name ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "pdf" | "xlsx">(null);
  const q = useQuery({ queryKey: ["weekly-report", id], queryFn: async () => unwrap(await supabase.rpc("get_weekly_report", { p_id: id })) as WeeklyReport });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert tone="error">{toAppError(q.error).message}</Alert>;
  const r = q.data!;
  const sections = buildSections(r, dateFormat);
  async function download(kind: "pdf" | "xlsx") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "pdf") await downloadReportPdf(r, dateFormat, company);
      else await downloadReportExcel(r, dateFormat, company);
      await supabase.rpc("log_activity", { p_action: "report.downloaded", p_module: "reports", p_details: { report: r.id, period_start: r.data.period.start, format: kind } });
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageHeader
        title={reportTitle(r, dateFormat)}
        description={`Compared with ${formatDate(r.data.previous.period.start, dateFormat)} to ${formatDate(r.data.previous.period.end, dateFormat)} · made ${formatDateTimeIST(r.generated_at, dateFormat)} ${r.kind === "scheduled" ? "automatically" : `by ${r.generated_by_name ?? "a user"}`}`}
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              All reports
            </Button>
            <Button variant="secondary" loading={busy === "xlsx"} onClick={() => void download("xlsx")}>
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <Button loading={busy === "pdf"} onClick={() => void download("pdf")}>
              <FileDown className="h-4 w-4" /> PDF
            </Button>
          </>
        }
      />
      {error && <div className="mb-3"><Alert tone="error">{error}</Alert></div>}
      {!r.financial && <div className="mb-3"><Alert tone="info">The financial section is shown only to users who may view payments.</Alert></div>}
      <div className="space-y-4">
        {sections.map((s) => (
          <Card key={s.key} title={`${s.key}. ${s.title}`}>
            {s.note && <p className="mb-3 text-xs text-slate-500">{s.note}</p>}
            {s.metrics.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Measure</th>
                    <th className={`${th} text-right`}>This week</th>
                    <th className={`${th} text-right`}>Previous week</th>
                    <th className={`${th} text-right`}>Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {s.metrics.map((m) => (
                    <tr key={m.label}>
                      <td className={td}>
                        {m.label}
                        {m.note && <p className="text-xs text-slate-500">{m.note}</p>}
                      </td>
                      <td className={`${td} text-right font-semibold tabular-nums`}>{m.value}</td>
                      <td className={`${td} text-right tabular-nums text-slate-600`}>{m.previous}</td>
                      <td className={cx(td, "text-right tabular-nums text-slate-600")}>{m.change}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {s.tables.map((t) => (
              <div key={t.title} className="mt-3">
                <p className="mb-1 text-sm font-semibold text-slate-800">{t.title}</p>
                {!t.rows.length ? (
                  <p className="text-sm text-slate-500">{t.empty}</p>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        {t.columns.map((c) => (
                          <th key={c} className={th}>
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {t.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j} className={td}>
                              {j === 0 && t.links?.[i] ? (
                                <Link to={`/jobs/${t.links[i]}`} className="font-medium text-brand-700 hover:underline">
                                  {cell}
                                </Link>
                              ) : (
                                cell
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </div>
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}
