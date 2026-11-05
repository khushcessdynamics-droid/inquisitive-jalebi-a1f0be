import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { formatINR } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import type { PartHistoryRow, QuoteHistoryRow } from "../../lib/phase5Types";
import { useDateFormat } from "../../hooks/data";
import { useCategories } from "../../hooks/master";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, td, th } from "../../components/ui";
import { PartJobs, PartQuotes } from "../../components/priceTables";

interface VendorPrices {
  vendor: string;
  jobs: number;
  quotes: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  last: number | null;
}

function summarise(jobs: PartHistoryRow[], quotes: QuoteHistoryRow[]): VendorPrices[] {
  const map = new Map<string, { jobs: number; quotes: number; rates: number[]; last: number | null; lastDate: string }>();
  for (const j of jobs) {
    const e = map.get(j.vendor_name) ?? { jobs: 0, quotes: 0, rates: [], last: null, lastDate: "" };
    e.jobs += 1;
    if (j.per_part !== null) {
      e.rates.push(j.per_part);
      if (j.dispatched_on > e.lastDate) {
        e.last = j.per_part;
        e.lastDate = j.dispatched_on;
      }
    }
    map.set(j.vendor_name, e);
  }
  for (const q of quotes) {
    const e = map.get(q.vendor_name) ?? { jobs: 0, quotes: 0, rates: [], last: null, lastDate: "" };
    e.quotes += 1;
    map.set(q.vendor_name, e);
  }
  return [...map.entries()]
    .map(([vendor, e]) => ({
      vendor,
      jobs: e.jobs,
      quotes: e.quotes,
      min: e.rates.length ? Math.min(...e.rates) : null,
      max: e.rates.length ? Math.max(...e.rates) : null,
      avg: e.rates.length ? Math.round((e.rates.reduce((a, b) => a + b, 0) / e.rates.length) * 100) / 100 : null,
      last: e.last,
    }))
    .sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity));
}

export function PriceHistoryPage() {
  const categories = useCategories();
  const dateFormat = useDateFormat();
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState<{ q: string; c: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const result = useQuery({
    queryKey: ["price-history", search],
    enabled: !!search,
    queryFn: async () => unwrap(await supabase.rpc("price_history", { p_query: search!.q || null, p_category_id: search!.c || null })) as { jobs: PartHistoryRow[]; quotes: QuoteHistoryRow[] },
  });
  const perVendor = useMemo(() => (result.data ? summarise(result.data.jobs, result.data.quotes) : []), [result.data]);

  async function exportExcel() {
    if (!result.data) return;
    setExportError(null);
    try {
      const v: ExportSheet<VendorPrices> = {
        name: "Per vendor",
        title: `Price history${search?.q ? ` for "${search.q}"` : ""}`,
        columns: [
          { header: "Vendor", value: (r) => r.vendor, width: 28 },
          { header: "Jobs with amount", value: (r) => r.jobs, format: "int" },
          { header: "Quotations", value: (r) => r.quotes, format: "int" },
          { header: "Lowest per part", value: (r) => r.min, format: "inr" },
          { header: "Average per part", value: (r) => r.avg, format: "inr" },
          { header: "Highest per part", value: (r) => r.max, format: "inr" },
          { header: "Latest per part", value: (r) => r.last, format: "inr" },
        ],
        rows: perVendor,
      };
      const j: ExportSheet<PartHistoryRow> = {
        name: "Jobs",
        columns: [
          { header: "Job No", value: (r) => r.job_no },
          { header: "Part", value: (r) => r.part_label, width: 30 },
          { header: "Category", value: (r) => r.category_name },
          { header: "Vendor", value: (r) => r.vendor_name, width: 24 },
          { header: "Given", value: (r) => r.dispatched_on, format: "date" },
          { header: "Qty", value: (r) => r.qty, format: "int" },
          { header: "Job amount", value: (r) => r.amount, format: "inr" },
          { header: "Per part", value: (r) => r.per_part, format: "inr" },
          { header: "State", value: (r) => r.state },
        ],
        rows: result.data.jobs,
      };
      const q: ExportSheet<QuoteHistoryRow> = {
        name: "Quotations",
        columns: [
          { header: "Comparison", value: (r) => r.request_no },
          { header: "Part", value: (r) => r.part_label, width: 30 },
          { header: "Vendor", value: (r) => r.vendor_name, width: 24 },
          { header: "Date", value: (r) => r.quote_date, format: "date" },
          { header: "Qty", value: (r) => r.qty, format: "int" },
          { header: "Per part", value: (r) => r.per_part, format: "inr" },
          { header: "Total", value: (r) => r.total, format: "inr" },
          { header: "Chosen", value: (r) => (r.selected ? "Yes" : "") },
        ],
        rows: result.data.quotes,
      };
      await downloadWorkbook(`CESS-Price-History-${new Date().toISOString().slice(0, 10)}.xlsx`, [v, j, q]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "quotations", p_details: { what: "price history", query: search } });
    } catch (e) {
      setExportError(toAppError(e).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Price History"
        description="What each vendor was given (job amount) and quoted for matching parts. Per-part rates are shown only where the quantity is known."
        actions={
          <Button variant="secondary" onClick={exportExcel} disabled={!result.data}>
            <Download className="h-4 w-4" /> Export to Excel
          </Button>
        }
      />
      <Card>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_16rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch({ q: text.trim(), c: category });
          }}
        >
          <Field label="Part No / Part Name contains" htmlFor="ph-q">
            <Input id="ph-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 4711 or Shaft" />
          </Field>
          <Field label="Machining category" htmlFor="ph-cat">
            <Select id="ph-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={text.trim().length < 2 && !category}>
            <Search className="h-4 w-4" /> Search
          </Button>
        </form>
      </Card>
      {exportError && <div className="mt-3"><Alert tone="error">{exportError}</Alert></div>}
      {search && (
        <div className="mt-4 space-y-4">
          {result.isLoading ? (
            <Spinner />
          ) : result.error ? (
            <Alert tone="error">{toAppError(result.error).message}</Alert>
          ) : !result.data?.jobs.length && !result.data?.quotes.length ? (
            <EmptyState title="Nothing found">No jobs with an amount and no quotations match.</EmptyState>
          ) : (
            <>
              <Card title="Per vendor (per-part rate from job amounts)">
                <Table>
                  <thead>
                    <tr>
                      <th className={th}>Vendor</th>
                      <th className={`${th} text-right`}>Jobs</th>
                      <th className={`${th} text-right`}>Quotations</th>
                      <th className={`${th} text-right`}>Lowest</th>
                      <th className={`${th} text-right`}>Average</th>
                      <th className={`${th} text-right`}>Highest</th>
                      <th className={`${th} text-right`}>Latest</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {perVendor.map((v) => (
                      <tr key={v.vendor}>
                        <td className={`${td} font-medium`}>{v.vendor}</td>
                        <td className={`${td} text-right tabular-nums`}>{v.jobs}</td>
                        <td className={`${td} text-right tabular-nums`}>{v.quotes}</td>
                        <td className={`${td} text-right tabular-nums`}>{v.min === null ? "—" : formatINR(v.min)}</td>
                        <td className={`${td} text-right tabular-nums`}>{v.avg === null ? "—" : formatINR(v.avg)}</td>
                        <td className={`${td} text-right tabular-nums`}>{v.max === null ? "—" : formatINR(v.max)}</td>
                        <td className={`${td} text-right tabular-nums`}>{v.last === null ? "—" : formatINR(v.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="mt-2 text-xs text-slate-500">Different parts can have very different rates; compare like with like (search one part number).</p>
              </Card>
              <Card title={`Jobs (${result.data.jobs.length})`}>
                <PartJobs rows={result.data.jobs} dateFormat={dateFormat} showPart empty="No jobs with an amount match." />
              </Card>
              <Card title={`Quotations (${result.data.quotes.length})`}>
                <PartQuotes rows={result.data.quotes} dateFormat={dateFormat} showPart />
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}
