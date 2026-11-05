import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CircleCheck, CircleSlash, Clock, Flag, PackageOpen } from "lucide-react";
import { commitmentOutcome, daysBetween, formatDate, formatDateTimeIST, lateness, todayIST, type DateFormat } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import type { AssignmentRow } from "../lib/types";
import type { CommitmentRevisionRow } from "../lib/phase5Types";
import { useRealtimeInvalidate, useSettings } from "../hooks/data";
import { Alert, Badge, Button, Field, Input, Modal, Textarea, cx } from "./ui";

export function useCommitmentHistory(jobId: string) {
  useRealtimeInvalidate(["commitment_revisions"], ["commitment-history", jobId]);
  return useQuery({
    queryKey: ["commitment-history", jobId],
    queryFn: async () =>
      unwrap(await supabase.from("commitment_history").select("*").eq("job_id", jobId).order("assignment_id").order("revision_no")) as CommitmentRevisionRow[],
  });
}

/** Revision count at which a commitment is highlighted as "frequently revised" (Settings > Reliability: revisions cap). */
export function useRevisionLimit(): number {
  const { data } = useSettings();
  return Number((data?.reliability?.value as { stability_revisions_cap?: number } | undefined)?.stability_revisions_cap ?? 2);
}

export function RevisionBadge({ count, limit }: { count: number; limit: number }) {
  if (!count) return null;
  return (
    <Badge tone={count >= limit ? "red" : "amber"}>
      Revised {count}×{count >= limit ? " · frequent" : ""}
    </Badge>
  );
}

// ------------------------------------------------------------------ revise dialog
export function ReviseCommitmentDialog({
  jobId,
  assignment,
  vendorName,
  revisions,
  open,
  onClose,
}: {
  jobId: string;
  assignment: AssignmentRow;
  vendorName: string;
  revisions: number;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState("");
  const [by, setBy] = useState<"vendor" | "cess" | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDate("");
      setBy("");
      setReason("");
      setError(null);
    }
  }, [open]);
  const today = todayIST();
  const current = assignment.current_commitment_date!;
  const moved = date ? daysBetween(current, date) : 0;
  const problem =
    !date ? "Enter the new committed date."
    : date === current ? "The new date is the same as the current committed date."
    : date < assignment.dispatched_on ? "The committed date cannot be before the date given to the vendor."
    : !by ? "Choose who asked for the change."
    : reason.trim().length < 3 ? "Enter the reason (at least 3 characters)."
    : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await supabase.rpc("revise_commitment", {
          p_assignment_id: assignment.id,
          p_expected_version: assignment.version,
          p_new_date: date,
          p_requested_by: by,
          p_reason: reason.trim(),
        }),
      );
      await Promise.all(
        [["job", jobId], ["job-assignments", jobId], ["job-activity", jobId], ["commitment-history", jobId], ["jobs"], ["job-tab-counts"]].map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
      );
      onClose();
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={`Revise committed date · ${vendorName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!!problem} onClick={save}>
            Save revision {revisions + 1}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 rounded-md bg-slate-50 p-3 text-sm">
        <div>
          <p className="text-xs text-slate-500">Original commitment (never changes)</p>
          <p className="font-medium">{formatDate(assignment.original_commitment_date)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Current commitment</p>
          <p className="font-medium">{formatDate(current)}</p>
        </div>
      </div>
      <Field label="New committed date" htmlFor="rc-date" hint={date && date !== current ? `${moved > 0 ? "+" : ""}${moved} days from the current date` : undefined}>
        <Input id="rc-date" type="date" min={assignment.dispatched_on} value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      {date && date < today && <Alert tone="warning">This date is already in the past: the job will show as Overdue.</Alert>}
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-slate-700">Who asked for the change?</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="rc-by" className="mt-1" checked={by === "vendor"} onChange={() => setBy("vendor")} />
          <span>
            The vendor asked for more time
            <span className="block text-xs text-slate-500">Counts in the vendor's commitment stability score.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="rc-by" className="mt-1" checked={by === "cess"} onChange={() => setBy("cess")} />
          <span>
            CESS asked for the change (drawing change, material late, priority change ...)
            <span className="block text-xs text-slate-500">Not held against the vendor's stability score.</span>
          </span>
        </label>
      </fieldset>
      <Field label="Reason for the change (saved permanently)" htmlFor="rc-reason">
        <Textarea id="rc-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <p className="text-xs text-slate-500">
        On-time delivery is always measured against the original date. This revision is added to the commitment history and cannot be edited or deleted later.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

// ------------------------------------------------------------------ timeline
type TimelineAssignment = AssignmentRow & { vendor: { name: string } | null };

function Event({ icon: Icon, tone, title, children }: { icon: typeof Clock; tone: string; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative -ml-[11px] pb-3 pl-7 last:pb-0">
      <span className={cx("absolute left-0 top-0.5 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-white", tone)}>
        <Icon className="h-3 w-3 text-white" aria-hidden />
      </span>
      <div className="text-sm text-slate-900">{title}</div>
      {children && <div className="mt-0.5 text-xs text-slate-600">{children}</div>}
    </li>
  );
}

export function CommitmentTimeline({
  assignments,
  revisions,
  dateFormat,
  limit,
}: {
  assignments: TimelineAssignment[];
  revisions: CommitmentRevisionRow[];
  dateFormat: DateFormat;
  limit: number;
}) {
  const today = todayIST();
  if (!assignments.length) return <p className="text-sm text-slate-600">Not given to a vendor yet (Draft).</p>;
  return (
    <div className="space-y-5">
      {assignments.map((a) => {
        const revs = revisions.filter((r) => r.assignment_id === a.id);
        const outcome = commitmentOutcome({
          state: a.state,
          original: a.original_commitment_date,
          current: a.current_commitment_date,
          completedOn: a.completed_on,
          cancelledOn: a.cancelled_on,
          today,
        });
        return (
          <div key={a.id}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">
                {a.sequence_no}. {a.vendor?.name}
              </span>
              <RevisionBadge count={revs.length} limit={limit} />
              {revs.length > 0 && (
                <span className="text-xs text-slate-500">
                  {revs.filter((r) => r.requested_by === "vendor").length} by vendor · {revs.filter((r) => r.requested_by === "cess").length} by CESS
                </span>
              )}
            </div>
            <ol className="relative ml-2.5 border-l-2 border-slate-200" aria-label={`Commitment timeline for ${a.vendor?.name ?? "vendor"}`}>
                <Event icon={PackageOpen} tone="bg-slate-500" title={<>Given to vendor · {formatDate(a.dispatched_on, dateFormat)}</>} />
                {a.original_commitment_date ? (
                  <Event icon={Flag} tone="bg-brand-600" title={<>Original commitment · <strong>{formatDate(a.original_commitment_date, dateFormat)}</strong></>}>
                    {daysBetween(a.dispatched_on, a.original_commitment_date)} days after the job was given
                  </Event>
                ) : (
                  <Event icon={Flag} tone="bg-violet-500" title="No committed date recorded">
                    No reminders, and left out of on-time scoring.
                  </Event>
                )}
                {revs.map((r) => (
                  <Event
                    key={r.id}
                    icon={CalendarClock}
                    tone={r.requested_by === "vendor" ? "bg-amber-500" : "bg-slate-400"}
                    title={
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>
                          Revision {r.revision_no} · {formatDate(r.previous_date, dateFormat)} → <strong>{formatDate(r.new_date, dateFormat)}</strong>
                          <span className="text-slate-500"> ({r.days_moved > 0 ? "+" : ""}{r.days_moved} days; {r.days_from_original > 0 ? "+" : ""}{r.days_from_original} from original)</span>
                        </span>
                        <Badge tone={r.requested_by === "vendor" ? "amber" : "slate"}>{r.requested_by === "vendor" ? "Requested by vendor" : "Requested by CESS"}</Badge>
                      </span>
                    }
                  >
                    {r.reason} · {r.changed_by_name ?? "—"} · {formatDateTimeIST(r.created_at, dateFormat)}
                  </Event>
                ))}
                {outcome.kind === "returned" && (
                  <Event icon={CircleCheck} tone={outcome.vsOriginal > 0 ? "bg-red-600" : "bg-emerald-600"} title={<>Returned · {formatDate(outcome.on, dateFormat)}</>}>
                    {lateness(outcome.vsOriginal)} against the original date{revs.length > 0 && <> · {lateness(outcome.vsLatest)} against the latest date</>}
                  </Event>
                )}
                {outcome.kind === "cancelled" && (
                  <Event icon={CircleSlash} tone="bg-slate-400" title={<>Cancelled{outcome.on ? ` · ${formatDate(outcome.on, dateFormat)}` : ""}</>} />
                )}
                {outcome.kind === "open" && (
                  <Event
                    icon={Clock}
                    tone={outcome.remaining < 0 ? "bg-red-600" : outcome.vsOriginal > 0 ? "bg-amber-500" : "bg-brand-600"}
                    title={
                      <>
                        Today · {formatDate(today, dateFormat)} ·{" "}
                        {outcome.remaining > 0 ? `due in ${outcome.remaining} day${outcome.remaining === 1 ? "" : "s"}` : outcome.remaining === 0 ? "due today" : `${-outcome.remaining} day${outcome.remaining === -1 ? "" : "s"} overdue`}
                      </>
                    }
                  >
                    {outcome.vsOriginal > 0 ? `${lateness(outcome.vsOriginal)} against the original date` : "Within the original date"}
                    {revs.length > 0 && <> · {outcome.vsLatest > 0 ? `${lateness(outcome.vsLatest)} against the latest date` : "within the latest date"}</>}
                  </Event>
                )}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
