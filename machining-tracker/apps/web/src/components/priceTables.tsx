import { Link } from "react-router-dom";
import { formatDate } from "@cess/shared";
import type { PartHistoryRow, QuoteHistoryRow } from "../lib/phase5Types";
import { Money } from "./jobs";
import { Badge, Table, td, th } from "./ui";

export function PartJobs({ rows, dateFormat, showPart, empty }: { rows: PartHistoryRow[]; dateFormat: Parameters<typeof formatDate>[1]; showPart?: boolean; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-600">{empty}</p>;
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>Job</th>
          <th className={th}>Vendor</th>
          <th className={th}>Given</th>
          <th className={`${th} text-right`}>Qty</th>
          <th className={`${th} text-right`}>Amount</th>
          <th className={`${th} text-right`}>Per part</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((h) => (
          <tr key={`${h.job_id}:${h.vendor_id}:${h.dispatched_on}`}>
            <td className={td}>
              <Link to={`/jobs/${h.job_id}`} className="font-medium text-brand-700 hover:underline">
                {h.job_no}
              </Link>
              {showPart && h.part_label && <p className="text-xs text-slate-500">{h.part_label}</p>}
              {h.state === "cancelled" && <p className="text-xs text-slate-500">cancelled</p>}
            </td>
            <td className={td}>{h.vendor_name}</td>
            <td className={`${td} whitespace-nowrap`}>{formatDate(h.dispatched_on, dateFormat)}</td>
            <td className={`${td} text-right tabular-nums`}>{h.qty ?? "—"}</td>
            <td className={`${td} text-right`}>
              <Money value={h.amount} />
            </td>
            <td className={`${td} text-right`}>
              <Money value={h.per_part} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function PartQuotes({ rows, dateFormat, showPart }: { rows: QuoteHistoryRow[]; dateFormat: Parameters<typeof formatDate>[1]; showPart?: boolean }) {
  if (!rows.length) return <p className="text-sm text-slate-600">No earlier quotations for this part.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>Comparison</th>
          <th className={th}>Vendor</th>
          <th className={th}>Date</th>
          <th className={`${th} text-right`}>Qty</th>
          <th className={`${th} text-right`}>Per part</th>
          <th className={`${th} text-right`}>Total</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((h, i) => (
          <tr key={`${h.request_id}:${h.vendor_name}:${i}`}>
            <td className={td}>
              <Link to={`/quotes/${h.request_id}`} className="font-medium text-brand-700 hover:underline">
                {h.request_no}
              </Link>
              {showPart && h.part_label && <p className="text-xs text-slate-500">{h.part_label}</p>}
            </td>
            <td className={td}>
              {h.vendor_name} {h.selected && <Badge tone="blue">Chosen</Badge>}
            </td>
            <td className={`${td} whitespace-nowrap`}>{formatDate(h.quote_date, dateFormat)}</td>
            <td className={`${td} text-right tabular-nums`}>{h.qty}</td>
            <td className={`${td} text-right`}>
              <Money value={h.per_part} />
            </td>
            <td className={`${td} text-right`}>
              <Money value={h.total} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
