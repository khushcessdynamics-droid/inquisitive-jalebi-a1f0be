import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { formatDate, formatINR, recentFinancialYears, todayIST, type DateFormat } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { useVendors } from "../../hooks/master";
import { KIND_LABEL, PAYMENT_MODES, PaymentStatusBadge, entryLabel, type LedgerEntry, type PaymentAccount, type PaymentStatus } from "../../components/payments";
import { MonthlyPaymentsChart } from "../../components/paymentCharts";
import { StatementDialog } from "../../components/vendorStatement";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, cx, td, th } from "../../components/ui";

const TABS = [
  { key: "pending", label: "Pending payments" },
  { key: "accounts", label: "All job accounts" },
  { key: "history", label: "Payment history" },
  { key: "vendors", label: "Vendor-wise" },
  { key: "periods", label: "Monthly / financial year" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const WORK: Record<string, string> = { open: "With vendor", completed: "Completed", cancelled: "Cancelled" };

async function logExport(what: string, rows: number) {
  await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "payments", p_details: { what, rows } });
}

function accountSheet(name: string, rows: PaymentAccount[]): ExportSheet<PaymentAccount> {
  return {
    name,
    title: `CESS vendor payments - ${name} - ${formatDate(todayIST())}`,
    columns: [
      { header: "Job No", value: (r) => r.job_no },
      { header: "Part No / Part Name", value: (r) => r.part_label, width: 30 },
      { header: "Vendor", value: (r) => r.vendor_name, width: 24 },
      { header: "Work", value: (r) => WORK[r.assignment_state] },
      { header: "Date given", value: (r) => r.dispatched_on, format: "date" },
      { header: "Invoice no", value: (r) => r.invoice_no },
      { header: "Invoice date", value: (r) => r.invoice_date, format: "date" },
      { header: "Job amount", value: (r) => r.job_amount, format: "inr" },
      { header: "Additional charges", value: (r) => r.additional_charges, format: "inr" },
      { header: "Discount", value: (r) => r.discount, format: "inr" },
      { header: "Total payable", value: (r) => r.total_payable, format: "inr" },
      { header: "Advance paid", value: (r) => r.advance_paid, format: "inr" },
      { header: "Amount paid", value: (r) => r.amount_paid, format: "inr" },
      { header: "Balance", value: (r) => r.balance, format: "inr" },
      { header: "Payment status", value: (r) => r.payment_status },
      { header: "Last payment", value: (r) => r.last_paid_on, format: "date" },
    ],
    rows,
  };
}

function AccountsTable({ rows, dateFormat }: { rows: PaymentAccount[]; dateFormat: DateFormat }) {
  const total = (k: "total_payable" | "amount_paid" | "balance") => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>Job</th>
          <th className={th}>Vendor</th>
          <th className={`${th} text-right`}>Job amount</th>
          <th className={`${th} text-right`}>Payable</th>
          <th className={`${th} text-right`}>Paid</th>
          <th className={`${th} text-right`}>Balance</th>
          <th className={th}>Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.assignment_id}>
            <td className={td}>
              <Link to={`/jobs/${r.job_id}`} className="font-medium text-brand-700 hover:underline">
                {r.job_no}
              </Link>
              <p className="text-xs text-slate-500">{r.part_label}</p>
            </td>
            <td className={td}>
              {r.vendor_name}
              <p className="text-xs text-slate-500">
                {WORK[r.assignment_state]} · given {formatDate(r.dispatched_on, dateFormat)}
              </p>
            </td>
            <td className={`${td} text-right tabular-nums`}>
              {r.job_amount === null ? <span className="text-amber-700">not recorded</span> : formatINR(r.job_amount)}
              {r.invoice_no && <p className="text-xs text-slate-500">inv. {r.invoice_no}</p>}
            </td>
            <td className={`${td} text-right tabular-nums`}>{r.total_payable === null ? "—" : formatINR(r.total_payable)}</td>
            <td className={`${td} text-right tabular-nums`}>
              {formatINR(r.amount_paid)}
              {r.advance_paid > 0 && <p className="text-xs text-slate-500">incl. advance {formatINR(r.advance_paid)}</p>}
            </td>
            <td className={cx(td, "text-right font-semibold tabular-nums", r.balance && r.balance > 0 ? "text-red-700" : "")}>{r.balance === null ? "—" : formatINR(r.balance)}</td>
            <td className={td}>
              <PaymentStatusBadge status={r.payment_status} />
              {r.last_paid_on && <p className="text-xs text-slate-500">last {formatDate(r.last_paid_on, dateFormat)}</p>}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-slate-50 font-semibold">
          <td className={td} colSpan={3}>
            Total ({rows.length})
          </td>
          <td className={`${td} text-right tabular-nums`}>{formatINR(total("total_payable"))}</td>
          <td className={`${td} text-right tabular-nums`}>{formatINR(total("amount_paid"))}</td>
          <td className={`${td} text-right tabular-nums`}>{formatINR(total("balance"))}</td>
          <td className={td} />
        </tr>
      </tfoot>
    </Table>
  );
}

function useAccounts() {
  useRealtimeInvalidate(["vendor_payments", "payment_adjustments", "job_assignments"], ["payment-accounts"]);
  return useQuery({
    queryKey: ["payment-accounts"],
    queryFn: async () => unwrap(await supabase.from("payment_accounts").select("*").order("dispatched_on", { ascending: false }).limit(5000)) as PaymentAccount[],
  });
}

export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "pending") as TabKey;
  const dateFormat = useDateFormat();
  return (
    <>
      <PageHeader title="Vendor Payments" description="Total payable = job amount + additional charges − discount. Balance = total payable − total paid. Entries are never edited; corrections are reversals." />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", tab === t.key ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:text-slate-900")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "pending" && <PendingTab dateFormat={dateFormat} />}
      {tab === "accounts" && <AccountsTab dateFormat={dateFormat} />}
      {tab === "history" && <HistoryTab dateFormat={dateFormat} />}
      {tab === "vendors" && <VendorsTab dateFormat={dateFormat} />}
      {tab === "periods" && <PeriodsTab />}
    </>
  );
}

function PendingTab({ dateFormat }: { dateFormat: DateFormat }) {
  const accounts = useAccounts();
  const [completedOnly, setCompletedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = (accounts.data ?? []).filter((r) => r.balance !== null && r.balance > 0 && (!completedOnly || r.assignment_state === "completed")).sort((a, b) => a.dispatched_on.localeCompare(b.dispatched_on));
  const unpriced = (accounts.data ?? []).filter((r) => r.job_amount === null);
  if (accounts.isLoading) return <Spinner />;
  if (accounts.error) return <Alert tone="error">{toAppError(accounts.error).message}</Alert>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={completedOnly} onChange={(e) => setCompletedOnly(e.target.checked)} /> Only work that is completed
        </label>
        <Button
          variant="secondary"
          disabled={!rows.length}
          onClick={async () => {
            try {
              await downloadWorkbook(`CESS-Pending-Payments-${todayIST()}.xlsx`, [accountSheet("Pending payments", rows)]);
              await logExport("pending payments", rows.length);
            } catch (e) {
              setError(toAppError(e).message);
            }
          }}
        >
          <Download className="h-4 w-4" /> Export to Excel
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {unpriced.length > 0 && <Alert tone="info">{unpriced.length} job(s) with advances but no job amount yet are not in this list (see All job accounts).</Alert>}
      {!rows.length ? <EmptyState title="Nothing pending">Every job amount that is recorded is fully paid.</EmptyState> : <AccountsTable rows={rows} dateFormat={dateFormat} />}
    </div>
  );
}

function AccountsTab({ dateFormat }: { dateFormat: DateFormat }) {
  const accounts = useAccounts();
  const vendors = useVendors();
  const [vendor, setVendor] = useState("");
  const [status, setStatus] = useState("");
  const [fy, setFy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const years = useMemo(() => recentFinancialYears(todayIST(), 8), []);
  const rows = (accounts.data ?? []).filter((r) => (!vendor || r.vendor_id === vendor) && (!status || r.payment_status === status) && (!fy || r.financial_year === fy));
  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <Field label="Vendor" htmlFor="pa-v">
            <Select id="pa-v" value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">All vendors</option>
              {(vendors.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment status" htmlFor="pa-s">
            <Select id="pa-s" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {(["Unpaid", "Advance Paid", "Partially Paid", "Fully Paid"] as PaymentStatus[]).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Financial year (job given)" htmlFor="pa-fy">
            <Select id="pa-fy" value={fy} onChange={(e) => setFy(e.target.value)}>
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            disabled={!rows.length}
            onClick={async () => {
              try {
                await downloadWorkbook(`CESS-Payment-Accounts-${todayIST()}.xlsx`, [accountSheet("Job accounts", rows)]);
                await logExport("payment accounts", rows.length);
              } catch (e) {
                setError(toAppError(e).message);
              }
            }}
          >
            <Download className="h-4 w-4" /> Export to Excel
          </Button>
        </div>
      </Card>
      {error && <Alert tone="error">{error}</Alert>}
      {accounts.isLoading ? <Spinner /> : accounts.error ? <Alert tone="error">{toAppError(accounts.error).message}</Alert> : !rows.length ? <EmptyState title="No job accounts match" /> : <AccountsTable rows={rows} dateFormat={dateFormat} />}
    </div>
  );
}

function HistoryTab({ dateFormat }: { dateFormat: DateFormat }) {
  useRealtimeInvalidate(["vendor_payments", "payment_adjustments"], ["payment-ledger"]);
  const vendors = useVendors();
  const [vendor, setVendor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ledger = useQuery({
    queryKey: ["payment-ledger", vendor, from, to],
    queryFn: async () => {
      let q = supabase.from("payment_ledger").select("*").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000);
      if (vendor) q = q.eq("vendor_id", vendor);
      if (from) q = q.gte("entry_date", from);
      if (to) q = q.lte("entry_date", to);
      return unwrap(await q) as LedgerEntry[];
    },
  });
  const rows = ledger.data ?? [];
  const paid = rows.filter((r) => r.entry_type === "payment").reduce((a, r) => a + Number(r.amount), 0);
  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <Field label="Vendor" htmlFor="ph-v">
            <Select id="ph-v" value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">All vendors</option>
              {(vendors.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" htmlFor="ph-from">
            <Input id="ph-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="ph-to">
            <Input id="ph-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button
            variant="secondary"
            disabled={!rows.length}
            onClick={async () => {
              try {
                const sheet: ExportSheet<LedgerEntry> = {
                  name: "Payment history",
                  title: `CESS payment history - ${formatDate(todayIST())}`,
                  columns: [
                    { header: "Date", value: (r) => r.entry_date, format: "date" },
                    { header: "Entry", value: (r) => entryLabel(r) },
                    { header: "Number", value: (r) => r.entry_no },
                    { header: "Vendor", value: (r) => r.vendor_name, width: 24 },
                    { header: "Job No", value: (r) => r.job_no },
                    { header: "Part", value: (r) => r.part_label, width: 28 },
                    { header: "Amount", value: (r) => r.amount, format: "inr" },
                    { header: "Mode", value: (r) => (r.mode ? PAYMENT_MODES[r.mode] : "") },
                    { header: "Reference", value: (r) => r.reference },
                    { header: "Remarks", value: (r) => r.remarks, width: 30 },
                    { header: "Reversed", value: (r) => (r.reversed ? "Yes" : "") },
                    { header: "Recorded by", value: (r) => r.recorded_by_name },
                  ],
                  rows,
                };
                await downloadWorkbook(`CESS-Payment-History-${todayIST()}.xlsx`, [sheet]);
                await logExport("payment history", rows.length);
              } catch (e) {
                setError(toAppError(e).message);
              }
            }}
          >
            <Download className="h-4 w-4" /> Export to Excel
          </Button>
        </div>
      </Card>
      {error && <Alert tone="error">{error}</Alert>}
      {ledger.isLoading ? (
        <Spinner />
      ) : ledger.error ? (
        <Alert tone="error">{toAppError(ledger.error).message}</Alert>
      ) : !rows.length ? (
        <EmptyState title="No entries" />
      ) : (
        <>
          <p className="text-sm text-slate-700">
            Net paid in this list: <strong>{formatINR(paid)}</strong> ({rows.length} entries, newest first)
          </p>
          <Table>
            <thead>
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Entry</th>
                <th className={th}>Vendor / job</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={th}>Mode / reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className={r.reversed ? "text-slate-400" : undefined}>
                  <td className={`${td} whitespace-nowrap`}>{formatDate(r.entry_date, dateFormat)}</td>
                  <td className={td}>
                    <span className={r.reversed ? "line-through" : ""}>{entryLabel(r)}</span>
                    {r.entry_no && <p className="text-xs text-slate-500">{r.entry_no}</p>}
                  </td>
                  <td className={td}>
                    {r.vendor_name}
                    <p className="text-xs">
                      <Link to={`/jobs/${r.job_id}`} className="text-brand-700 hover:underline">
                        {r.job_no}
                      </Link>{" "}
                      <span className="text-slate-500">{r.part_label}</span>
                    </p>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{formatINR(r.kind === "discount" ? -r.amount : r.amount)}</td>
                  <td className={`${td} text-xs`}>
                    {r.mode ? PAYMENT_MODES[r.mode] : KIND_LABEL[r.kind]}
                    {r.reference && <p className="text-slate-500">{r.reference}</p>}
                    {r.remarks && <p className="text-slate-500">{r.remarks}</p>}
                    <p className="text-slate-400">by {r.recorded_by_name ?? "—"}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}

interface VendorSummary {
  vendor_id: string;
  vendor_name: string;
  accounts: number;
  job_amount: number;
  additional_charges: number;
  discount: number;
  total_payable: number;
  amount_paid: number;
  advance_paid: number;
  outstanding: number;
  unpriced_accounts: number;
  fully_paid: number;
  last_paid_on: string | null;
}

function VendorsTab({ dateFormat }: { dateFormat: DateFormat }) {
  useRealtimeInvalidate(["vendor_payments", "payment_adjustments", "job_assignments"], ["payment-summary"]);
  const [fy, setFy] = useState("");
  const [statementFor, setStatementFor] = useState<VendorSummary | null>(null);
  const years = useMemo(() => recentFinancialYears(todayIST(), 8), []);
  const summary = useQuery({
    queryKey: ["payment-summary", fy],
    queryFn: async () => unwrap(await supabase.rpc("vendor_payment_summary", { p: fy ? { fy } : {} })) as VendorSummary[],
  });
  const rows = summary.data ?? [];
  const sum = (k: "total_payable" | "amount_paid" | "outstanding") => rows.reduce((a, r) => a + Number(r[k]), 0);
  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="Jobs given in financial year" htmlFor="pv-fy">
            <Select id="pv-fy" value={fy} onChange={(e) => setFy(e.target.value)}>
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      {summary.isLoading ? (
        <Spinner />
      ) : summary.error ? (
        <Alert tone="error">{toAppError(summary.error).message}</Alert>
      ) : !rows.length ? (
        <EmptyState title="No vendor job amounts or payments yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Vendor</th>
              <th className={`${th} text-right`}>Total payable</th>
              <th className={`${th} text-right`}>Total paid</th>
              <th className={`${th} text-right`}>Outstanding</th>
              <th className={th}>Jobs</th>
              <th className={th}>
                <span className="sr-only">Statement</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.vendor_id}>
                <td className={`${td} font-medium`}>
                  <Link to={`/vendors/${r.vendor_id}`} className="text-brand-700 hover:underline">
                    {r.vendor_name}
                  </Link>
                  {r.last_paid_on && <p className="text-xs font-normal text-slate-500">last paid {formatDate(r.last_paid_on, dateFormat)}</p>}
                </td>
                <td className={`${td} text-right tabular-nums`}>{formatINR(r.total_payable)}</td>
                <td className={`${td} text-right tabular-nums`}>
                  {formatINR(r.amount_paid)}
                  {r.advance_paid > 0 && <p className="text-xs text-slate-500">advances {formatINR(r.advance_paid)}</p>}
                </td>
                <td className={cx(td, "text-right font-semibold tabular-nums", r.outstanding > 0 ? "text-red-700" : "")}>{formatINR(r.outstanding)}</td>
                <td className={`${td} text-xs`}>
                  {r.accounts} ({r.fully_paid} fully paid{r.unpriced_accounts ? `, ${r.unpriced_accounts} without amount` : ""})
                </td>
                <td className={td}>
                  <Button variant="ghost" className="whitespace-nowrap" onClick={() => setStatementFor(r)}>
                    <FileText className="h-4 w-4" /> Statement
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-semibold">
              <td className={td}>Total</td>
              <td className={`${td} text-right tabular-nums`}>{formatINR(sum("total_payable"))}</td>
              <td className={`${td} text-right tabular-nums`}>{formatINR(sum("amount_paid"))}</td>
              <td className={`${td} text-right tabular-nums`}>{formatINR(sum("outstanding"))}</td>
              <td className={td} colSpan={2} />
            </tr>
          </tfoot>
        </Table>
      )}
      {statementFor && <StatementDialog vendorId={statementFor.vendor_id} vendorName={statementFor.vendor_name} dateFormat={dateFormat} onClose={() => setStatementFor(null)} />}
    </div>
  );
}

function PeriodsTab() {
  useRealtimeInvalidate(["vendor_payments"], ["payment-periods"]);
  const years = useMemo(() => recentFinancialYears(todayIST(), 8), []);
  const [fy, setFy] = useState(years[0]!);
  const data = useQuery({
    queryKey: ["payment-periods", fy],
    queryFn: async () =>
      unwrap(await supabase.rpc("payments_by_period", { p_fy: fy })) as {
        fy: string;
        months: Array<{ month: string; paid: number; advances: number; entries: number }>;
        years: Array<{ fy: string; paid: number; entries: number }>;
      },
  });
  if (data.isLoading) return <Spinner />;
  if (data.error) return <Alert tone="error">{toAppError(data.error).message}</Alert>;
  const d = data.data!;
  const fyTotal = d.months.reduce((a, m) => a + Number(m.paid), 0);
  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="Financial year" htmlFor="pp-fy">
            <Select id="pp-fy" value={fy} onChange={(e) => setFy(e.target.value)}>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </Select>
          </Field>
          <p className="text-sm text-slate-700 sm:col-span-2">
            Paid in FY {d.fy}: <strong>{formatINR(fyTotal)}</strong> (by payment date; reversals subtracted)
          </p>
        </div>
      </Card>
      <Card>
        <MonthlyPaymentsChart months={d.months} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Monthly payments, FY ${d.fy}`}>
          <Table>
            <thead>
              <tr>
                <th className={th}>Month</th>
                <th className={`${th} text-right`}>Paid</th>
                <th className={`${th} text-right`}>of which advances</th>
                <th className={`${th} text-right`}>Entries</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {d.months.map((m) => (
                <tr key={m.month}>
                  <td className={td}>{formatDate(`${m.month}-01`).slice(3)}</td>
                  <td className={`${td} text-right tabular-nums`}>{formatINR(m.paid)}</td>
                  <td className={`${td} text-right tabular-nums`}>{formatINR(m.advances)}</td>
                  <td className={`${td} text-right tabular-nums`}>{m.entries}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title="Payments per financial year">
          {!d.years.length ? (
            <p className="text-sm text-slate-600">No payments yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Financial year</th>
                  <th className={`${th} text-right`}>Paid</th>
                  <th className={`${th} text-right`}>Entries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.years.map((y) => (
                  <tr key={y.fy}>
                    <td className={td}>{y.fy}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatINR(y.paid)}</td>
                    <td className={`${td} text-right tabular-nums`}>{y.entries}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
