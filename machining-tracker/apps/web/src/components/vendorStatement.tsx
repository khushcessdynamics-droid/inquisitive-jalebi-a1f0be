import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { formatDate, formatINR, recentFinancialYears, todayIST, type DateFormat } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../lib/excel";
import { Alert, Button, Field, Input, Modal, Spinner, Table, td, th } from "./ui";

interface StatementLine {
  date: string;
  type: string;
  job_no: string;
  part_label: string;
  reference: string;
  payable: number;
  paid: number;
  balance: number;
}
interface Statement {
  vendor: { name: string; vendor_code: string; company_name: string; gst_no: string; address: string };
  from: string | null;
  to: string | null;
  opening_balance: number;
  lines: StatementLine[];
  total_payable: number;
  total_paid: number;
  closing_balance: number;
}

export function StatementDialog({ vendorId, vendorName, dateFormat, onClose }: { vendorId: string; vendorName: string; dateFormat: DateFormat; onClose: () => void }) {
  const fy = recentFinancialYears(todayIST(), 1)[0]!;
  const [from, setFrom] = useState(`${fy.slice(0, 4)}-04-01`);
  const [to, setTo] = useState(todayIST());
  const [error, setError] = useState<string | null>(null);
  const st = useQuery({
    queryKey: ["vendor-statement", vendorId, from, to],
    queryFn: async () => unwrap(await supabase.rpc("vendor_statement", { p_vendor_id: vendorId, p_from: from || null, p_to: to || null })) as Statement,
  });
  async function download() {
    if (!st.data) return;
    setError(null);
    try {
      const s = st.data;
      const opening: StatementLine = { date: s.from ?? "", type: "Opening balance", job_no: "", part_label: "", reference: "", payable: 0, paid: 0, balance: s.opening_balance };
      const sheet: ExportSheet<StatementLine> = {
        name: "Statement",
        title: `Vendor statement: ${s.vendor.name} (${s.vendor.vendor_code})${s.vendor.gst_no ? ` GSTIN ${s.vendor.gst_no}` : ""} - ${s.from ? formatDate(s.from) : "start"} to ${s.to ? formatDate(s.to) : "today"}`,
        columns: [
          { header: "Date", value: (r) => r.date || null, format: "date" },
          { header: "Entry", value: (r) => r.type, width: 22 },
          { header: "Job No", value: (r) => r.job_no },
          { header: "Part", value: (r) => r.part_label, width: 28 },
          { header: "Reference", value: (r) => r.reference, width: 30 },
          { header: "Payable (+)", value: (r) => (r.payable ? r.payable : null), format: "inr" },
          { header: "Paid (-)", value: (r) => (r.paid ? r.paid : null), format: "inr" },
          { header: "Balance", value: (r) => r.balance, format: "inr" },
        ],
        rows: [opening, ...s.lines, { date: s.to ?? "", type: "Closing balance", job_no: "", part_label: "", reference: "", payable: s.total_payable, paid: s.total_paid, balance: s.closing_balance }],
      };
      await downloadWorkbook(`CESS-Statement-${vendorName.replace(/[^A-Za-z0-9]+/g, "-")}-${from || "start"}-to-${to || "today"}.xlsx`, [sheet]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "payments", p_details: { what: "vendor statement", vendor: vendorName, rows: s.lines.length } });
    } catch (e) {
      setError(toAppError(e).message);
    }
  }
  return (
    <Modal
      open
      wide
      title={`Payment statement · ${vendorName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={download} disabled={!st.data}>
            <Download className="h-4 w-4" /> Download Excel
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" htmlFor="st-from">
          <Input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="st-to">
          <Input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {st.isLoading ? (
        <Spinner />
      ) : st.error ? (
        <Alert tone="error">{toAppError(st.error).message}</Alert>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Date</th>
              <th className={th}>Entry</th>
              <th className={`${th} text-right`}>Payable</th>
              <th className={`${th} text-right`}>Paid</th>
              <th className={`${th} text-right`}>Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <tr className="bg-slate-50">
              <td className={td} colSpan={4}>
                Opening balance
              </td>
              <td className={`${td} text-right font-semibold tabular-nums`}>{formatINR(st.data!.opening_balance)}</td>
            </tr>
            {st.data!.lines.map((l, i) => (
              <tr key={i}>
                <td className={`${td} whitespace-nowrap`}>{formatDate(l.date, dateFormat)}</td>
                <td className={td}>
                  {l.type} · {l.job_no}
                  {l.reference && <p className="text-xs text-slate-500">{l.reference}</p>}
                </td>
                <td className={`${td} text-right tabular-nums`}>{l.payable ? formatINR(l.payable) : ""}</td>
                <td className={`${td} text-right tabular-nums`}>{l.paid ? formatINR(l.paid) : ""}</td>
                <td className={`${td} text-right tabular-nums`}>{formatINR(l.balance)}</td>
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold">
              <td className={td} colSpan={2}>
                Closing balance
              </td>
              <td className={`${td} text-right tabular-nums`}>{formatINR(st.data!.total_payable)}</td>
              <td className={`${td} text-right tabular-nums`}>{formatINR(st.data!.total_paid)}</td>
              <td className={`${td} text-right tabular-nums`}>{formatINR(st.data!.closing_balance)}</td>
            </tr>
          </tbody>
        </Table>
      )}
    </Modal>
  );
}

