import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { formatDate, recentFinancialYears, todayIST } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { useCategories, useVendors } from "../../hooks/master";
import { QualityBadge } from "../../components/returns";
import { Alert, Button, Card, EmptyState, Field, PageHeader, Select, Spinner, Table, cx, td, th } from "../../components/ui";

interface QualityRecord {
  id: string;
  job_id: string;
  job_no: string;
  part_label: string;
  category_name: string;
  vendor_id: string;
  vendor_name: string;
  return_no: number;
  returned_on: string;
  qty_received: number;
  challan_no: string;
  inspected_on: string;
  qty_accepted: number;
  qty_rejected: number;
  qty_rework: number;
  qty_inspected: number;
  quality_status: string;
  inspector_name: string;
  remarks: string;
  recorded_by_name: string | null;
  financial_year: string;
}

interface PendingLot {
  id: string;
  job_id: string;
  vendor_name: string;
  return_no: number;
  returned_on: string;
  qty_received: number;
  qty_uninspected: number;
  job: { job_no: string; part_label: string } | null;
}

export function QualityPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "pending" ? "pending" : "records";
  const dateFormat = useDateFormat();
  const years = useMemo(() => recentFinancialYears(todayIST(), 8), []);
  const fy = params.get("fy") ?? years[0]!;
  const [vendor, setVendor] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const vendors = useVendors();
  const categories = useCategories();
  useRealtimeInvalidate(["quality_inspections", "material_returns"], ["quality"]);

  const records = useQuery({
    queryKey: ["quality", "records", fy, vendor, category],
    enabled: tab === "records",
    queryFn: async () => {
      let q = supabase.from("quality_records").select("*").order("inspected_on", { ascending: false }).limit(5000);
      if (fy !== "all") q = q.eq("financial_year", fy);
      if (vendor) q = q.eq("vendor_id", vendor);
      if (category) q = q.eq("category_id", category);
      return unwrap(await q) as QualityRecord[];
    },
  });
  const pending = useQuery({
    queryKey: ["quality", "pending"],
    enabled: tab === "pending",
    queryFn: async () => {
      const lots = unwrap(await supabase.from("material_return_lots").select("id,job_id,vendor_name,return_no,returned_on,qty_received,qty_uninspected").is("voided_at", null).gt("qty_uninspected", 0).order("returned_on")) as Omit<PendingLot, "job">[];
      const ids = [...new Set(lots.map((l) => l.job_id))];
      const jobs = ids.length ? (unwrap(await supabase.from("jobs").select("id,job_no,part_label,archived_at").in("id", ids)) as Array<{ id: string; job_no: string; part_label: string; archived_at: string | null }>) : [];
      const byId = new Map(jobs.map((j) => [j.id, j]));
      return lots.filter((l) => byId.has(l.job_id) && !byId.get(l.job_id)!.archived_at).map((l) => ({ ...l, job: byId.get(l.job_id) ?? null })) as PendingLot[];
    },
  });

  const rows = records.data ?? [];
  const sum = (k: "qty_inspected" | "qty_accepted" | "qty_rejected" | "qty_rework") => rows.reduce((a, r) => a + r[k], 0);
  const inspected = sum("qty_inspected");

  async function exportExcel() {
    setError(null);
    try {
      const sheet: ExportSheet<QualityRecord> = {
        name: "Quality records",
        title: `CESS quality inspection records - ${fy === "all" ? "all years" : `FY ${fy}`}`,
        columns: [
          { header: "Inspection date", value: (r) => r.inspected_on, format: "date" },
          { header: "Job No", value: (r) => r.job_no },
          { header: "Part No / Part Name", value: (r) => r.part_label, width: 30 },
          { header: "Category", value: (r) => r.category_name },
          { header: "Vendor", value: (r) => r.vendor_name, width: 24 },
          { header: "Return no", value: (r) => r.return_no, format: "int" },
          { header: "Return date", value: (r) => r.returned_on, format: "date" },
          { header: "Challan", value: (r) => r.challan_no },
          { header: "Inspected", value: (r) => r.qty_inspected, format: "int" },
          { header: "Accepted", value: (r) => r.qty_accepted, format: "int" },
          { header: "Rejected", value: (r) => r.qty_rejected, format: "int" },
          { header: "Rework", value: (r) => r.qty_rework, format: "int" },
          { header: "Quality status", value: (r) => r.quality_status },
          { header: "Inspected by", value: (r) => r.inspector_name },
          { header: "Remarks", value: (r) => r.remarks, width: 30 },
          { header: "Recorded by", value: (r) => r.recorded_by_name },
        ],
        rows,
      };
      await downloadWorkbook(`CESS-Quality-Records-${fy}-${todayIST()}.xlsx`, [sheet]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "jobs", p_details: { what: "quality records", rows: rows.length, fy } });
    } catch (e) {
      setError(toAppError(e).message);
    }
  }

  return (
    <>
      <PageHeader title="Quality" description="Every inspection of returned material, and returns still waiting for inspection." />
      <div className="mb-4 flex gap-1 border-b border-slate-200" role="tablist">
        {(
          [
            ["records", "Inspection records"],
            ["pending", "Waiting for inspection"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setParams({ tab: k, fy }, { replace: true })}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === k ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:text-slate-900")}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "records" ? (
        <div className="space-y-3">
          <Card>
            <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <Field label="Financial year (inspection date)" htmlFor="q-fy">
                <Select id="q-fy" value={fy} onChange={(e) => setParams({ tab, fy: e.target.value }, { replace: true })}>
                  {years.map((y) => (
                    <option key={y}>{y}</option>
                  ))}
                  <option value="all">All years</option>
                </Select>
              </Field>
              <Field label="Vendor" htmlFor="q-v">
                <Select id="q-v" value={vendor} onChange={(e) => setVendor(e.target.value)}>
                  <option value="">All vendors</option>
                  {(vendors.data ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Category" htmlFor="q-c">
                <Select id="q-c" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All categories</option>
                  {(categories.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="secondary" onClick={exportExcel} disabled={!rows.length}>
                <Download className="h-4 w-4" /> Export to Excel
              </Button>
            </div>
          </Card>
          {error && <Alert tone="error">{error}</Alert>}
          {records.isLoading ? (
            <Spinner />
          ) : records.error ? (
            <Alert tone="error">{toAppError(records.error).message}</Alert>
          ) : !rows.length ? (
            <EmptyState title="No inspections recorded for this selection" />
          ) : (
            <>
              <p className="text-sm text-slate-700">
                {rows.length} inspections · {inspected} pieces · accepted <strong>{sum("qty_accepted")}</strong> ({((100 * sum("qty_accepted")) / inspected).toFixed(1)}%) · rejected{" "}
                <strong>{sum("qty_rejected")}</strong> · rework <strong>{sum("qty_rework")}</strong>
              </p>
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Inspected</th>
                    <th className={th}>Job / part</th>
                    <th className={th}>Vendor</th>
                    <th className={`${th} text-right`}>Accepted</th>
                    <th className={`${th} text-right`}>Rejected</th>
                    <th className={`${th} text-right`}>Rework</th>
                    <th className={th}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className={`${td} whitespace-nowrap`}>
                        {formatDate(r.inspected_on, dateFormat)}
                        <p className="text-xs text-slate-500">{r.inspector_name}</p>
                      </td>
                      <td className={td}>
                        <Link to={`/jobs/${r.job_id}`} className="font-medium text-brand-700 hover:underline">
                          {r.job_no}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {r.part_label} · return {r.return_no} ({formatDate(r.returned_on, dateFormat)})
                        </p>
                      </td>
                      <td className={td}>{r.vendor_name}</td>
                      <td className={`${td} text-right tabular-nums`}>{r.qty_accepted}</td>
                      <td className={`${td} text-right tabular-nums`}>{r.qty_rejected}</td>
                      <td className={`${td} text-right tabular-nums`}>{r.qty_rework}</td>
                      <td className={td}>
                        <QualityBadge status={r.quality_status} />
                        {r.remarks && <p className="text-xs text-slate-500">{r.remarks}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </div>
      ) : pending.isLoading ? (
        <Spinner />
      ) : pending.error ? (
        <Alert tone="error">{toAppError(pending.error).message}</Alert>
      ) : !pending.data?.length ? (
        <EmptyState title="Nothing waiting for inspection" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Returned</th>
              <th className={th}>Job / part</th>
              <th className={th}>Vendor</th>
              <th className={`${th} text-right`}>To inspect</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pending.data.map((l) => (
              <tr key={l.id}>
                <td className={`${td} whitespace-nowrap`}>{formatDate(l.returned_on, dateFormat)}</td>
                <td className={td}>
                  <Link to={`/jobs/${l.job_id}`} className="font-medium text-brand-700 hover:underline">
                    {l.job?.job_no}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {l.job?.part_label} · return {l.return_no}
                  </p>
                </td>
                <td className={td}>{l.vendor_name}</td>
                <td className={`${td} text-right font-semibold tabular-nums`}>
                  {l.qty_uninspected} <span className="font-normal text-slate-500">of {l.qty_received}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
