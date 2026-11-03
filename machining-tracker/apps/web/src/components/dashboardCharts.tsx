// Dashboard charts. Colors: categorical slots in fixed order (validated: #3460b8, #eb6834), status colors only for
// on-time / late (with labels). Thin marks, rounded data ends, recessive grid, tooltips; every value is also shown as a
// label or in the dashboard tables. Clicking a mark opens the matching records.
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { formatINR } from "@cess/shared";
import { cx } from "./ui";

export const SERIES_1 = "#3460b8";
export const SERIES_2 = "#eb6834";
const GRID = "#e2e8f0";
const MUTED = "#475569";
const STATUS_GOOD = "#0ca30c";
const STATUS_CRITICAL = "#d03b3b";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

function Tip({ active, payload, label, fmt }: TooltipContentProps<number, string> & { fmt: (v: number, name: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      {payload.map((p) =>
        p.value === null || p.value === undefined ? null : (
          <p key={String(p.dataKey)} className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3" style={{ background: p.color }} aria-hidden />
            <span className="font-semibold text-slate-900">{fmt(Number(p.value), String(p.name))}</span>
            <span className="text-slate-500">{p.name}</span>
          </p>
        ),
      )}
      <p className="mt-0.5 text-slate-500">{label}</p>
    </div>
  );
}

function Figure({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <figure>
      <figcaption className="mb-1 text-sm font-semibold text-slate-800">{title}</figcaption>
      {children}
      {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
    </figure>
  );
}

export function JobTrendChart({ months, onMonth }: { months: Array<{ month: string; started: number; completed: number; future: boolean }>; onMonth: (m: string) => void }) {
  const data = months.map((m) => ({ ...m, label: monthLabel(m.month), started: m.future ? null : m.started, completed: m.future ? null : m.completed }));
  return (
    <Figure title="Monthly job trend" note="Started = given to the first vendor (drafts: entered). Click a month to open its jobs.">
      <ResponsiveContainer width="100%" height={230}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} onClick={(e) => e?.activeLabel && onMonth(data.find((d) => d.label === e.activeLabel)!.month)}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tickFormatter={(v: string) => v.slice(0, 3)} tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} interval={0} />
          <YAxis allowDecimals={false} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
          <Tooltip cursor={{ fill: "#f1f5f9" }} content={(p) => <Tip {...(p as TooltipContentProps<number, string>)} fmt={(v) => String(v)} />} />
          <Legend iconType="rect" iconSize={10} wrapperStyle={{ fontSize: 12, color: MUTED }} />
          <Bar dataKey="started" name="Started" fill={SERIES_1} barSize={10} radius={[3, 3, 0, 0]} isAnimationActive={false} className="cursor-pointer" />
          <Bar dataKey="completed" name="Completed" fill={SERIES_2} barSize={10} radius={[3, 3, 0, 0]} isAnimationActive={false} className="cursor-pointer" />
        </BarChart>
      </ResponsiveContainer>
    </Figure>
  );
}

export function SpendingChart({ months, onMonth }: { months: Array<{ month: string; spending: number | null; future: boolean }>; onMonth: (m: string) => void }) {
  const data = months.map((m) => ({ label: monthLabel(m.month), month: m.month, spending: m.future ? null : m.spending }));
  return (
    <Figure title="Monthly vendor spending (payments made)" note="By payment date, reversals subtracted.">
      <ResponsiveContainer width="100%" height={230}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} onClick={(e) => e?.activeLabel && onMonth(data.find((d) => d.label === e.activeLabel)!.month)}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tickFormatter={(v: string) => v.slice(0, 3)} tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} interval={0} />
          <YAxis tickFormatter={(v: number) => `₹${compact.format(v)}`} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
          <Tooltip cursor={{ fill: "#f1f5f9" }} content={(p) => <Tip {...(p as TooltipContentProps<number, string>)} fmt={(v) => formatINR(v)} />} />
          <Bar dataKey="spending" name="Paid" fill={SERIES_1} barSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} className="cursor-pointer" />
        </BarChart>
      </ResponsiveContainer>
    </Figure>
  );
}

/** Ranked horizontal bars, one hue (nominal categories: identity is the label, not the color). */
export function RankedBars({
  title,
  rows,
  valueLabel,
  format = (v) => String(v),
  onClick,
  note,
  max,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: number; tag?: string }>;
  valueLabel: string;
  format?: (v: number) => string;
  onClick?: (key: string) => void;
  note?: ReactNode;
  max?: number;
}) {
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  return (
    <Figure title={title} note={note}>
      {!rows.length ? (
        <p className="py-6 text-sm text-slate-500">No data for this period.</p>
      ) : (
        <ul className="space-y-1.5" aria-label={title}>
          {rows.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                disabled={!onClick}
                onClick={() => onClick?.(r.key)}
                className={cx("grid w-full grid-cols-[minmax(0,9rem)_1fr] items-center gap-2 rounded text-left text-xs", onClick && "hover:bg-slate-50")}
                title={`${r.label}: ${format(r.value)} ${valueLabel}`}
              >
                <span className="truncate text-slate-800">{r.label}</span>
                <span className="flex items-center gap-2">
                  <span className="h-3.5 rounded-r" style={{ width: `${Math.max(2, (100 * r.value) / top)}%`, background: SERIES_1 }} aria-hidden />
                  <span className="shrink-0 tabular-nums text-slate-700">
                    {format(r.value)}
                    {r.tag ? ` · ${r.tag}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Figure>
  );
}

/** One whole split into parts: tall segmented bar with 2px gaps, the value printed where it fits, legend of names. */
export function SegmentedBar({
  title,
  parts,
  note,
}: {
  title: string;
  parts: Array<{ key: string; label: string; value: number; color: string; textColor?: string; onClick?: () => void }>;
  note?: ReactNode;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <Figure title={title} note={note}>
      {total === 0 ? (
        <p className="py-6 text-sm text-slate-500">No data for this period.</p>
      ) : (
        <>
          <div className="flex h-9 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
            {parts
              .filter((p) => p.value > 0)
              .map((p) => {
                const pct = (100 * p.value) / total;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={p.onClick}
                    title={`${p.label}: ${p.value} (${pct.toFixed(0)}%)`}
                    className="flex items-center justify-center text-xs font-semibold first:rounded-l last:rounded-r hover:opacity-90"
                    style={{ width: `${pct}%`, background: p.color, color: p.textColor ?? "#ffffff" }}
                  >
                    {pct >= 12 ? p.value : ""}
                  </button>
                );
              })}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
            {parts.map((p) => (
              <li key={p.key} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
                <button type="button" onClick={p.onClick} className="hover:underline">
                  {p.label} <strong className="tabular-nums">{p.value}</strong> ({total ? Math.round((100 * p.value) / total) : 0}%)
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Figure>
  );
}

export const STATUS = { good: STATUS_GOOD, critical: STATUS_CRITICAL };

export function RejectionTrendChart({ months }: { months: Array<{ month: string; inspected: number; rejected_or_rework: number; future: boolean }> }) {
  const data = months.map((m) => ({
    label: monthLabel(m.month),
    pct: !m.future && m.inspected > 0 ? Math.round((1000 * m.rejected_or_rework) / m.inspected) / 10 : null,
    inspected: m.inspected,
  }));
  const any = data.some((d) => d.pct !== null);
  return (
    <Figure title="Quality rejection trend (rejected + rework, % of inspected pieces)" note="Months without inspections are left empty, not shown as 0%.">
      {!any ? (
        <p className="py-6 text-sm text-slate-500">No inspections in this period.</p>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <LineChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tickFormatter={(v: string) => v.slice(0, 3)} tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} interval={0} />
            <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={40} domain={[0, "auto"]} />
            <Tooltip content={(p) => <Tip {...(p as TooltipContentProps<number, string>)} fmt={(v) => `${v.toFixed(1)}%`} />} />
            <Line dataKey="pct" name="Rejected + rework" stroke={SERIES_1} strokeWidth={2} dot={{ r: 4, fill: SERIES_1, stroke: "#ffffff", strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Figure>
  );
}
