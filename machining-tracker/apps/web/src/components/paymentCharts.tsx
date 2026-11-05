// Monthly payments of one financial year: a single series (one hue, no legend; the title names it), thin columns
// with a rounded top, value labels only on the largest month, tooltip per column. All values are also in the table.
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { formatINR } from "@cess/shared";

const SERIES = "#3460b8";
const GRID = "#e2e8f0";
const MUTED = "#475569";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

interface Point {
  label: string;
  paid: number;
  top: string;
}

function Tip({ active, payload }: TooltipContentProps<number, string>) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload as Point;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="text-sm font-semibold text-slate-900">{formatINR(p.paid)}</p>
      <p className="text-slate-500">{p.label}</p>
    </div>
  );
}

export function MonthlyPaymentsChart({ months }: { months: Array<{ month: string; paid: number }> }) {
  const max = Math.max(0, ...months.map((m) => m.paid));
  const data: Point[] = months.map((m) => ({
    label: `${MONTHS[Number(m.month.slice(5, 7)) - 1]} ${m.month.slice(2, 4)}`,
    paid: m.paid,
    top: max > 0 && m.paid === max ? `₹${compact.format(m.paid)}` : "",
  }));
  return (
    <figure role="img" aria-label={`Payments per month: ${data.map((d) => `${d.label} ${formatINR(d.paid, true)}`).join(", ")}`}>
      <figcaption className="mb-1 text-sm font-semibold text-slate-800">Paid per month (net of reversals)</figcaption>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 20, right: 8, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
          <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} interval={0} />
          <YAxis tickFormatter={(v: number) => `₹${compact.format(v)}`} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
          <Tooltip cursor={{ fill: "#f1f5f9" }} content={(props) => <Tip {...(props as TooltipContentProps<number, string>)} />} />
          <Bar dataKey="paid" fill={SERIES} barSize={20} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <LabelList dataKey="top" position="top" fill="#334155" fontSize={11} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
