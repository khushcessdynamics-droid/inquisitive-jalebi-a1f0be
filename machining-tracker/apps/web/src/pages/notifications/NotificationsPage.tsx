import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, CalendarClock, CheckCheck, Info, MessageCircle, PlayCircle } from "lucide-react";
import { formatDate, formatDateTimeIST } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { WhatsAppDialog, suggestTemplate } from "../../components/whatsapp";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, cx } from "../../components/ui";

interface NotificationRow {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  job_id: string | null;
  vendor_id: string | null;
  reminder_id: string | null;
  created_at: string;
  read_at: string | null;
  reminder: { kind: string } | null;
}

interface Upcoming {
  date: string;
  kind: "upcoming" | "due_today" | "overdue";
  job_id: string;
  job_no: string;
  part_label: string;
  vendor_name: string;
  commitment_date: string;
  pending_qty: number | null;
}

const KIND_LABEL = { upcoming: "Due soon", due_today: "Due today", overdue: "Overdue" } as const;
const KIND_TONE = { upcoming: "blue", due_today: "amber", overdue: "red" } as const;

export function NotificationsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const dateFormat = useDateFormat();
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const [wa, setWa] = useState<{ jobId: string; template: string } | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useRealtimeInvalidate(["notifications"], ["notifications"]);

  const list = useQuery({
    queryKey: ["notifications", tab],
    queryFn: async () => {
      let q = supabase.from("notifications").select("*, reminder:reminders(kind)").order("created_at", { ascending: false }).limit(300);
      if (tab === "unread") q = q.is("read_at", null);
      return unwrap(await q) as unknown as NotificationRow[];
    },
  });
  const upcoming = useQuery({
    queryKey: ["upcoming-reminders"],
    queryFn: async () => unwrap(await supabase.rpc("upcoming_reminders", { p_days: 7 })) as Upcoming[],
  });
  const engine = useQuery({
    queryKey: ["reminder-engine"],
    enabled: can("system.view"),
    queryFn: async () =>
      unwrap(await supabase.rpc("reminder_engine_status")) as {
        scheduled: boolean;
        settings: { enabled: boolean; run_time_ist: string };
        last_runs: Array<{ run_date: string; last_run_at: string; runs: number; reminders_created: number; notifications_created: number }>;
      },
  });

  async function markRead(ids: string[] | null) {
    setError(null);
    try {
      unwrap(await supabase.rpc("mark_notifications_read", { p_ids: ids }));
      await Promise.all([qc.invalidateQueries({ queryKey: ["notifications"] }), qc.invalidateQueries({ queryKey: ["unread-count"] })]);
    } catch (e) {
      setError(toAppError(e).message);
    }
  }

  const rows = list.data ?? [];
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Reminders are created by the server every day at the time set in Settings (Indian time), whether or not anyone has the app open."
        actions={
          rows.some((r) => !r.read_at) && (
            <Button variant="secondary" onClick={() => void markRead(null)}>
              <CheckCheck className="h-4 w-4" /> Mark all as read
            </Button>
          )
        }
      />
      {error && <div className="mb-3"><Alert tone="error">{error}</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-3 flex gap-1 border-b border-slate-200" role="tablist">
            {(["unread", "all"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:text-slate-900")}
              >
                {t === "unread" ? "Unread" : "All"}
              </button>
            ))}
          </div>
          {list.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <Alert tone="error">{toAppError(list.error).message}</Alert>
          ) : !rows.length ? (
            <EmptyState title={tab === "unread" ? "No unread notifications" : "No notifications yet"} />
          ) : (
            <ul className="space-y-2">
              {rows.map((n) => (
                <li key={n.id} className={cx("rounded-md border bg-white px-3 py-2", n.read_at ? "border-slate-200" : "border-brand-100 bg-brand-50/40")}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      {n.severity === "critical" ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-label="Overdue" />
                      ) : n.severity === "warning" ? (
                        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-label="Due today" />
                      ) : (
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-label="Upcoming" />
                      )}
                      <div className="min-w-0">
                        <p className={cx("text-sm", n.read_at ? "text-slate-700" : "font-semibold text-slate-900")}>
                          {n.job_id ? (
                            <Link to={`/jobs/${n.job_id}`} className="hover:underline">
                              {n.title}
                            </Link>
                          ) : (
                            n.title
                          )}
                        </p>
                        <p className="text-xs text-slate-600">{n.body}</p>
                        <p className="text-xs text-slate-400">{formatDateTimeIST(n.created_at, dateFormat)}</p>
                      </div>
                    </div>
                    <span className="flex gap-1">
                      {n.job_id && can("whatsapp.send") && (
                        <Button variant="secondary" className="px-2.5 py-1" onClick={() => setWa({ jobId: n.job_id!, template: suggestTemplate(null, { reminder: n.reminder?.kind }) })}>
                          <MessageCircle className="h-4 w-4" /> WhatsApp
                        </Button>
                      )}
                      {!n.read_at && (
                        <Button variant="ghost" className="px-2.5 py-1" onClick={() => void markRead([n.id])}>
                          Mark read
                        </Button>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-4">
          <Card title="Reminders in the next 7 days">
            {upcoming.isLoading ? (
              <Spinner />
            ) : upcoming.error ? (
              <Alert tone="error">{toAppError(upcoming.error).message}</Alert>
            ) : !upcoming.data?.length ? (
              <p className="text-sm text-slate-600">No reminders due.</p>
            ) : (
              <ul className="space-y-2">
                {upcoming.data.map((u, i) => (
                  <li key={`${u.job_id}-${u.date}-${i}`} className="text-sm">
                    <span className="text-xs text-slate-500">{formatDate(u.date, dateFormat)}</span>{" "}
                    <Badge tone={KIND_TONE[u.kind]}>{KIND_LABEL[u.kind]}</Badge>
                    <p>
                      <Link to={`/jobs/${u.job_id}`} className="font-medium text-brand-700 hover:underline">
                        {u.job_no}
                      </Link>{" "}
                      <span className="text-slate-600">
                        {u.vendor_name} · committed {formatDate(u.commitment_date, dateFormat)}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-slate-500">Calculated from each job's latest committed date, so revisions move the reminders automatically. Jobs without a committed date get no reminders.</p>
          </Card>
          {can("system.view") && (
            <Card title="Reminder engine">
              {engine.isLoading ? (
                <Spinner />
              ) : engine.error ? (
                <Alert tone="error">{toAppError(engine.error).message}</Alert>
              ) : (
                <div className="space-y-2 text-sm">
                  <p className="flex items-center gap-2">
                    <Bell className="h-4 w-4" />
                    {engine.data!.settings.enabled ? (
                      engine.data!.scheduled ? (
                        <>Runs daily from {engine.data!.settings.run_time_ist} IST (checked every 15 minutes on the server)</>
                      ) : (
                        <span className="text-red-700">The server schedule is missing</span>
                      )
                    ) : (
                      <span className="text-amber-700">Switched off in Settings</span>
                    )}
                  </p>
                  {engine.data!.last_runs.length ? (
                    <ul className="text-xs text-slate-600">
                      {engine.data!.last_runs.map((r) => (
                        <li key={r.run_date}>
                          {formatDate(r.run_date, dateFormat)}: {r.reminders_created} reminders, {r.notifications_created} notifications (last check {formatDateTimeIST(r.last_run_at, dateFormat)})
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-500">No runs recorded yet.</p>
                  )}
                  {can("settings.change") && (
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        setRunResult(null);
                        try {
                          const r = unwrap(await supabase.rpc("run_reminders_now")) as { ran: boolean; reminders_created?: number; reason?: string };
                          setRunResult(r.ran ? `${r.reminders_created ?? 0} new reminders created (existing ones are never repeated).` : (r.reason ?? "Not run"));
                          await Promise.all([qc.invalidateQueries({ queryKey: ["reminder-engine"] }), qc.invalidateQueries({ queryKey: ["notifications"] }), qc.invalidateQueries({ queryKey: ["unread-count"] })]);
                        } catch (e) {
                          setRunResult(toAppError(e).message);
                        }
                      }}
                    >
                      <PlayCircle className="h-4 w-4" /> Run reminders now
                    </Button>
                  )}
                  {runResult && <p className="text-xs text-slate-700">{runResult}</p>}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      {wa && <WhatsAppDialog jobId={wa.jobId} initialTemplate={wa.template} open onClose={() => setWa(null)} />}
    </>
  );
}
