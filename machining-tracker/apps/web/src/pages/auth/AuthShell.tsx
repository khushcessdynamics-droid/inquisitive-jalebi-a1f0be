import type { ReactNode } from "react";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-900 to-brand-700 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3 text-white">
          <img src="/favicon.svg" alt="" className="h-10 w-10" />
          <div className="leading-tight">
            <p className="text-lg font-semibold">CESS Machining Tracker</p>
            <p className="text-xs text-brand-100">Outsourced job &amp; vendor management</p>
          </div>
        </div>
        <div className="space-y-4 rounded-xl bg-white p-6 shadow-xl">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
