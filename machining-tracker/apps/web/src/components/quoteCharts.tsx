// Cost comparison charts (Recharts). One series each, so one hue and no legend; the chart title names the measure.
// Bars are ranked, thin (20px), with a rounded data end and a value label at the tip. Tooltips add the per-part rate
// (the average is in the tiles above, not drawn as a line, so it never crosses a value label);
// every value is also in the comparison table, so nothing depends on hovering.
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { formatINR } from "@cess/shared";
import type { ComparedQuote } from "../lib/phase5Types";

const SERIES = "#3460b8"; // brand blue stepped into the validated lightness band (passes contrast on white)
const GRID = "#e2e8f0"; // slate-200 hairline
const TEXT_MUTED = "#475569"; // slate-600
const compactINR = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

interface Point {
  vendor: string;
  total: number;
  per_part: number;
  days: number | null;
  tag: string;
  note: string;
}

/** Phones get shorter labels and margins so the bars keep most of the width. */
function useNarrow(): boolean {
  const query = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function ChartTooltip({ active, payload, unit }: TooltipContentProps<number, string> & { unit: "inr" | "days" }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload as Point;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      {unit === "inr" ? (
        <>
          <p className="text-sm font-semibold text-slate-900">{formatINR(p.total)}</p>
          <p className="text-slate-600">{formatINR(p.per_part)} per part</p>
        </>
      ) : (
        <p className="text-sm font-semibold text-slate-900">{p.days} days</p>
      )}
      <p className="mt-0.5 text-slate-500">
        {p.vendor}
        {p.note ? ` · ${p.note}` : ""}
      </p>
    </div>
  );
}

function height(n: number) {
  return Math.max(120, n * 40 + 48);
}

export function TotalCostChart({ quotes, recommendedId }: { quotes: ComparedQuote[]; recommendedId: string | null }) {
  const narrow = useNarrow();
  const data: Point[] = [...quotes]
    .sort((a, b) => a.total - b.total)
    .map((q) => {
      const note = q.id === recommendedId ? "recommended" : "";
      return { vendor: q.vendor_name, total: q.total, per_part: q.per_part, days: q.delivery_days, note, tag: `${formatINR(q.total, true)}${note && !narrow ? ` · ${note}` : ""}` };
    });
  return (
    <figure role="img" aria-label={`Total cost for the required quantity: ${data.map((d) => `${d.vendor} ${formatINR(d.total, true)}`).join(", ")}`}>
      <figcaption className="mb-1 text-sm font-semibold text-slate-800">Total cost for the required quantity</figcaption>
      <ResponsiveContainer width="100%" height={height(data.length)}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: narrow ? 72 : 150, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
          <XAxis type="number" tickFormatter={(v: number) => `₹${compactINR.format(v)}`} tick={{ fill: TEXT_MUTED, fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="vendor" width={narrow ? 92 : 130} tick={{ fill: "#0f172a", fontSize: narrow ? 11 : 12 }} axisLine={{ stroke: GRID }} tickLine={false} />
          <Tooltip cursor={{ fill: "#f1f5f9" }} content={(props) => <ChartTooltip {...(props as TooltipContentProps<number, string>)} unit="inr" />} />
          <Bar dataKey="total" fill={SERIES} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList dataKey="tag" position="right" fill="#334155" fontSize={12} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function DeliveryChart({ quotes }: { quotes: ComparedQuote[] }) {
  const narrow = useNarrow();
  const withDays = quotes.filter((q) => q.delivery_days !== null);
  const missing = quotes.length - withDays.length;
  const data: Point[] = [...withDays]
    .sort((a, b) => (a.delivery_days ?? 0) - (b.delivery_days ?? 0))
    .map((q) => {
      const note = q.is_fastest ? "fastest" : "";
      return { vendor: q.vendor_name, total: q.total, per_part: q.per_part, days: q.delivery_days, note, tag: `${q.delivery_days} days${note && !narrow ? ` · ${note}` : ""}` };
    });
  return (
    <figure role="img" aria-label={`Expected delivery days: ${data.map((d) => `${d.vendor} ${d.days} days`).join(", ")}`}>
      <figcaption className="mb-1 text-sm font-semibold text-slate-800">Expected delivery days</figcaption>
      {data.length === 0 ? (
        <p className="py-6 text-sm text-slate-500">No vendor has stated delivery days yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={height(data.length)}>
          <BarChart data={data} layout="vertical" margin={{ top: 8, right: narrow ? 64 : 120, bottom: 4, left: 4 }}>
            <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
            <XAxis type="number" allowDecimals={false} tick={{ fill: TEXT_MUTED, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="vendor" width={narrow ? 92 : 130} tick={{ fill: "#0f172a", fontSize: narrow ? 11 : 12 }} axisLine={{ stroke: GRID }} tickLine={false} />
            <Tooltip cursor={{ fill: "#f1f5f9" }} content={(props) => <ChartTooltip {...(props as TooltipContentProps<number, string>)} unit="days" />} />
            <Bar dataKey="days" fill={SERIES} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              <LabelList dataKey="tag" position="right" fill="#334155" fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      {missing > 0 && <p className="text-xs text-slate-500">{missing} quotation{missing === 1 ? "" : "s"} without delivery days not shown.</p>}
    </figure>
  );
}
