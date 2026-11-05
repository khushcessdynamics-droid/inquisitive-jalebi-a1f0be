import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarCheck, CalendarClock, CheckCircle2, MessageCircle, Pencil, RotateCcw, Send, Shuffle, Archive } from "lucide-react";
import { formatDate, formatDateTimeIST, formatINR } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { actionLabel, actorLabel } from "../../lib/activity";
import type { ActivityRow, AssignmentRow, JobRegisterRow } from "../../lib/types";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { DateText, DueText, Money, SourceBadge, StatusBadge } from "../../components/jobs";
import { AttachmentsCard } from "../../components/Attachments";
import { CommitmentTimeline, ReviseCommitmentDialog, RevisionBadge, useCommitmentHistory, useRevisionLimit } from "../../components/commitments";
import { ReturnsCard } from "../../components/returns";
import { PaymentsCard } from "../../components/payments";
import { WhatsAppDialog, WhatsAppHistory, suggestTemplate } from "../../components/whatsapp";
import { CancelForwardDialog, EditAssignmentDialog, EditJobDialog, ReclassifyDialog, SendToVendorDialog } from "../../components/jobForms";
import { Alert, Badge, Button, Card, PageHeader, ReasonDialog, Spinner, cx } from "../../components/ui";

type AssignmentWithNames = AssignmentRow & { vendor: { name: string } | null; reason: { label: string; vendor_related: boolean } | null };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export function JobDetailPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const created = (location.state as { created?: string } | null)?.created;
  const { access, can } = useAuth();
  const dateFormat = useDateFormat();
  const qc = useQueryClient();
  useRealtimeInvalidate(["jobs", "job_assignments", "material_returns", "quality_inspections"], ["job", id]);
  useRealtimeInvalidate(["job_assignments"], ["job-assignments", id]);

  const job = useQuery({
    queryKey: ["job", id],
    queryFn: async () => unwrap(await supabase.from("job_register").select("*").eq("id", id).maybeSingle()) as unknown as JobRegisterRow | null,
  });
  const assignments = useQuery({
    queryKey: ["job-assignments", id],
    queryFn: async () =>
      unwrap(
        await supabase
          .from("job_assignments")
          .select("*, vendor:vendors(name), reason:cancel_reason_codes(label, vendor_related)")
          .eq("job_id", id)
          .order("sequence_no"),
      ) as unknown as AssignmentWithNames[],
  });
  const activity = useQuery({
    queryKey: ["job-activity", id],
    queryFn: async () => unwrap(await supabase.rpc("job_activity", { p_job_id: id })) as ActivityRow[],
  });
  const samePart = useQuery({
    queryKey: ["same-part", job.data?.part_label, id],
    enabled: !!job.data,
    queryFn: async () => {
      const exact = job.data!.part_label.replace(/[\\%_]/g, (c) => `\\${c}`);
      return unwrap(
        await supabase.from("job_register").select("id,job_no,status,vendor_name,date_given,return_date").ilike("part_label", exact).neq("id", id).order("date_given", { ascending: false }).limit(20),
      ) as unknown as Array<Pick<JobRegisterRow, "id" | "job_no" | "status" | "vendor_name" | "date_given" | "return_date">>;
    },
  });

  const history = useCommitmentHistory(id);
  const revisionLimit = useRevisionLimit();
  const [dialog, setDialog] = useState<null | "edit" | "send" | "assignment" | "cancel" | "archive" | "revise" | "close" | "reopen" | "whatsapp">(null);
  const [reclassify, setReclassify] = useState<AssignmentWithNames | null>(null);

  if (job.isLoading) return <Spinner />;
  if (job.error) return <Alert tone="error">{toAppError(job.error).message}</Alert>;
  const j = job.data;
  if (!j) return <Alert tone="warning" title="Job not found">It does not exist or you do not have access to it.</Alert>;

  const open = assignments.data?.find((a) => a.state === "open") ?? null;
  const editMode: "all" | "operational" | null = can("jobs.edit")
    ? "all"
    : can("jobs.edit_assigned") && (j.assigned_staff_id === access?.user_id || j.created_by === access?.user_id)
      ? "operational"
      : null;

  return (
    <>
      <PageHeader
        title={`${j.job_no} · ${j.part_label}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={j.status} /> <DueText remaining={j.remaining_days} delay={j.status === "Overdue" ? j.delay_days_current : null} />
            <SourceBadge source={j.source} />
            {j.long_pending && <Badge tone="amber">With vendor for more than the long-pending limit</Badge>}
          </span>
        }
        actions={
          !j.archived_at && (
            <>
              {j.assignment_id && can("whatsapp.send") && (
                <Button variant="secondary" onClick={() => setDialog("whatsapp")}>
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </Button>
              )}
              {editMode && (
                <Button variant="secondary" onClick={() => setDialog("edit")}>
                  <Pencil className="h-4 w-4" /> Edit job
                </Button>
              )}
              {j.status === "Draft" && can("jobs.create") && (
                <Button onClick={() => setDialog("send")}>
                  <Send className="h-4 w-4" /> Send to vendor
                </Button>
              )}
              {open && editMode && !j.closed_at && (
                <Button variant="secondary" onClick={() => setDialog("assignment")}>
                  <CalendarCheck className="h-4 w-4" /> {open.original_commitment_date ? "Vendor details" : "Record committed date"}
                </Button>
              )}
              {open && open.current_commitment_date && can("commitments.change") && !j.closed_at && (
                <Button variant="secondary" onClick={() => setDialog("revise")}>
                  <CalendarClock className="h-4 w-4" /> Revise commitment
                </Button>
              )}
              {open && can("jobs.cancel") && !j.closed_at && (
                <Button variant="danger" onClick={() => setDialog("cancel")}>
                  <Shuffle className="h-4 w-4" /> Cancel / forward vendor
                </Button>
              )}
              {open && !j.closed_at && can("jobs.edit") && j.qty_received > 0 && (
                <Button variant="secondary" onClick={() => setDialog("close")}>
                  <CheckCircle2 className="h-4 w-4" /> Close job
                </Button>
              )}
              {j.closed_at && can("jobs.edit") && (
                <Button variant="secondary" onClick={() => setDialog("reopen")}>
                  <RotateCcw className="h-4 w-4" /> Reopen job
                </Button>
              )}
              {!open && can("jobs.archive") && (
                <Button variant="ghost" onClick={() => setDialog("archive")}>
                  <Archive className="h-4 w-4" /> Archive
                </Button>
              )}
            </>
          )
        }
      />
      {created && <div className="mb-4"><Alert tone="success">Job {created} saved.</Alert></div>}
      {j.closed_reason && <div className="mb-4"><Alert tone="info" title="Completed">{j.closed_reason}</Alert></div>}
      {j.archived_at && <div className="mb-4"><Alert tone="warning" title="Archived">This job is archived and read-only.</Alert></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Key dates and numbers" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Date given to vendor"><DateText value={j.date_given} format={dateFormat} /></Fact>
            <Fact label="Original commitment"><DateText value={j.original_commitment_date} format={dateFormat} empty="Not recorded" /></Fact>
            <Fact label="Current commitment">
              <DateText value={j.current_commitment_date} format={dateFormat} empty="Not recorded" />
              {j.revision_count > 0 && <> <RevisionBadge count={j.revision_count} limit={revisionLimit} /></>}
            </Fact>
            <Fact label="Actual return (final)">
              <DateText value={j.return_date} format={dateFormat} empty={j.qty_received > 0 ? `${j.qty_received} pcs back so far` : "Not returned"} />
            </Fact>
            <Fact label="Days since given">{j.days_since_given ?? "—"}</Fact>
            <Fact label="Remaining days">{j.remaining_days !== null && j.remaining_days >= 0 ? j.remaining_days : "—"}</Fact>
            <Fact label="Delay vs original commitment">{j.delay_days !== null ? `${j.delay_days} day${j.delay_days === 1 ? "" : "s"}` : "—"}</Fact>
            <Fact label="Delay vs latest commitment">{j.delay_days_current !== null ? `${j.delay_days_current} day${j.delay_days_current === 1 ? "" : "s"}` : "—"}</Fact>
            <Fact label="Quantity sent">{j.qty_sent ?? <span className="text-amber-700">Not specified</span>}</Fact>
            <Fact label="Job amount"><Money value={j.amount} /></Fact>
            <Fact label="Financial year">{j.financial_year ?? "—"}</Fact>
          </dl>
        </Card>
        <Card title="Job details">
          <dl className="space-y-3">
            <Fact label="Work category">{j.category_name}</Fact>
            <Fact label="Given By">{j.given_by_name ?? "—"}</Fact>
            <Fact label="Assigned staff user">{j.assigned_staff_name ?? "—"}</Fact>
            <Fact label="Created by">
              {j.created_by_name ?? "Excel import"} · {formatDateTimeIST(j.created_at, dateFormat)}
            </Fact>
            {j.description && <Fact label="Description">{j.description}</Fact>}
            {j.remarks && <Fact label="Remarks">{j.remarks}</Fact>}
          </dl>
        </Card>
      </div>

      <Card className="mt-4" title="Material returns and quality inspection">
        {assignments.isLoading ? (
          <Spinner />
        ) : (
          <ReturnsCard jobId={j.id} assignments={assignments.data ?? []} jobClosed={!!j.closed_at || !!j.archived_at} dateFormat={dateFormat} />
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title={`Vendor journey (${assignments.data?.length ?? 0})`} className="lg:col-span-2">
          {assignments.isLoading ? (
            <Spinner />
          ) : !assignments.data?.length ? (
            <p className="text-sm text-slate-600">Not given to a vendor yet (Draft).</p>
          ) : (
            <ol className="relative space-y-4 border-l-2 border-slate-200 pl-5">
              {assignments.data.map((a) => (
                <li key={a.id} className="relative">
                  <span
                    className={cx(
                      "absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-white",
                      a.state === "open" ? "bg-brand-600" : a.state === "completed" ? "bg-emerald-600" : "bg-slate-400",
                    )}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {a.sequence_no}. {a.vendor?.name}
                    </span>
                    {a.state === "open" && <Badge tone="blue">Current vendor</Badge>}
                    {a.state === "completed" && <Badge tone="green">Returned</Badge>}
                    {a.state === "cancelled" && <Badge>Cancelled</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-slate-700">
                    Given {formatDate(a.dispatched_on, dateFormat)}
                    {a.qty_sent ? ` · ${a.qty_sent} pcs` : ""}
                    {a.amount !== null ? ` · ${formatINR(a.amount)}` : ""}
                    {a.original_commitment_date ? ` · committed ${formatDate(a.original_commitment_date, dateFormat)}` : " · no commitment recorded"}
                    {a.current_commitment_date && a.current_commitment_date !== a.original_commitment_date ? ` (now ${formatDate(a.current_commitment_date, dateFormat)})` : ""}
                    {a.completed_on ? ` · returned ${formatDate(a.completed_on, dateFormat)}` : ""}
                  </p>
                  {a.state === "cancelled" && (
                    <div className="mt-1 rounded-md bg-slate-50 px-3 py-2 text-sm">
                      <p>
                        Cancelled {a.cancelled_on ? formatDate(a.cancelled_on, dateFormat) : ""}: <strong>{a.reason?.label}</strong>{" "}
                        {a.reason && (a.reason.vendor_related ? <Badge tone="red">Vendor-caused</Badge> : <Badge>Not vendor-caused</Badge>)}
                      </p>
                      <p className="text-slate-600">{a.cancel_reason_text}</p>
                      {a.cancel_reason_code === "legacy_unclassified" && can("jobs.cancel") && (
                        <Button variant="secondary" className="mt-2" onClick={() => setReclassify(a)}>
                          Classify reason
                        </Button>
                      )}
                    </div>
                  )}
                  {a.remarks && <p className="mt-1 text-xs text-slate-500">{a.remarks}</p>}
                  {a.state === "cancelled" && assignments.data!.find((n) => n.previous_assignment_id === a.id) && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                      <ArrowRight className="h-3 w-3" /> forwarded to {assignments.data!.find((n) => n.previous_assignment_id === a.id)?.vendor?.name}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <AttachmentsCard jobId={j.id} assignmentId={open?.id ?? null} />
      </div>

      {can("payments.view") && (
        <Card className="mt-4" title="Payments">
          {assignments.isLoading ? <Spinner /> : <PaymentsCard jobId={j.id} assignments={assignments.data ?? []} dateFormat={dateFormat} archived={!!j.archived_at} />}
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Commitment timeline" className="lg:col-span-2">
          {history.error ? (
            <Alert tone="error">{toAppError(history.error).message}</Alert>
          ) : assignments.isLoading || history.isLoading ? (
            <Spinner />
          ) : (
            <CommitmentTimeline assignments={assignments.data ?? []} revisions={history.data ?? []} dateFormat={dateFormat} limit={revisionLimit} />
          )}
        </Card>
        <Card title="Other jobs for this part">
          {!samePart.data?.length ? (
            <p className="text-sm text-slate-600">No other jobs for this part.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {samePart.data.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <Link to={`/jobs/${s.id}`} className="font-medium text-brand-700 hover:underline">
                      {s.job_no}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {s.vendor_name ?? "—"} · {s.date_given ? formatDate(s.date_given, dateFormat) : "draft"}
                    </span>
                  </span>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="History of this job" className={can("whatsapp.send") ? "lg:col-span-2" : "lg:col-span-3"}>
          {activity.isLoading ? (
            <Spinner />
          ) : activity.error ? (
            <Alert tone="error">{toAppError(activity.error).message}</Alert>
          ) : (
            <ul className="space-y-2">
              {[...(activity.data ?? [])].reverse().map((e) => (
                <li key={e.id} className="text-sm">
                  <span className="font-medium text-slate-800">{actionLabel(e.action)}</span>
                  <span className="text-slate-500"> · {actorLabel(e)} · {formatDateTimeIST(e.occurred_at, dateFormat)}</span>
                  {e.reason && <p className="text-xs text-slate-600">Reason: {e.reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {can("whatsapp.send") && (
          <Card title="WhatsApp with the vendor">
            <WhatsAppHistory jobId={j.id} dateFormat={dateFormat} limit={20} />
          </Card>
        )}
      </div>

      {editMode && <EditJobDialog job={j} mode={editMode} open={dialog === "edit"} onClose={() => setDialog(null)} />}
      <SendToVendorDialog job={j} open={dialog === "send"} onClose={() => setDialog(null)} />
      {open && editMode && <EditAssignmentDialog job={j} assignment={open} mode={editMode} open={dialog === "assignment"} onClose={() => setDialog(null)} />}
      {dialog === "whatsapp" && (
        <WhatsAppDialog
          jobId={j.id}
          initialTemplate={suggestTemplate(j.status, { rejected: j.qty_rejected, hasCommitment: !!j.current_commitment_date })}
          open
          onClose={() => setDialog(null)}
        />
      )}
      {open && open.current_commitment_date && (
        <ReviseCommitmentDialog
          jobId={j.id}
          assignment={open}
          vendorName={open.vendor?.name ?? ""}
          revisions={(history.data ?? []).filter((r) => r.assignment_id === open.id).length}
          open={dialog === "revise"}
          onClose={() => setDialog(null)}
        />
      )}
      {open && <CancelForwardDialog job={j} assignment={open} vendorName={open.vendor?.name ?? ""} open={dialog === "cancel"} onClose={() => setDialog(null)} />}
      {reclassify && <ReclassifyDialog assignmentId={reclassify.id} version={reclassify.version} jobId={j.id} open onClose={() => setReclassify(null)} />}
      <ReasonDialog
        open={dialog === "close"}
        title="Close this job?"
        message={
          <>
            Use this when the job will not complete by itself: rejected pieces accepted as final, remaining pieces not needed, or the quantity was never recorded.
            {j.qty_with_vendor ? <strong> {j.qty_with_vendor} pieces are still with the vendor.</strong> : null} The last return date becomes the completion date.
          </>
        }
        confirmLabel="Close job"
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("close_job", { p_job_id: j.id, p_expected_version: j.version, p_reason: reason }));
          setDialog(null);
          await Promise.all([["job", id], ["job-assignments", id], ["job-activity", id], ["returns", id], ["jobs"]].map((queryKey) => qc.invalidateQueries({ queryKey })));
        }}
      />
      <ReasonDialog
        open={dialog === "reopen"}
        title="Reopen this job?"
        message="The last vendor assignment becomes open again so returns and inspections can be corrected. Everything recorded so far is kept."
        confirmLabel="Reopen job"
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("reopen_job", { p_job_id: j.id, p_expected_version: j.version, p_reason: reason }));
          setDialog(null);
          await Promise.all([["job", id], ["job-assignments", id], ["job-activity", id], ["returns", id], ["jobs"]].map((queryKey) => qc.invalidateQueries({ queryKey })));
        }}
      />
      <ReasonDialog
        open={dialog === "archive"}
        title="Archive this job?"
        message="The job and its full history are kept, but it is hidden from the register and becomes read-only."
        confirmLabel="Archive"
        danger
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("archive_job", { p_job_id: j.id, p_expected_version: j.version, p_reason: reason }));
          setDialog(null);
          await qc.invalidateQueries({ queryKey: ["job", id] });
          await qc.invalidateQueries({ queryKey: ["jobs"] });
        }}
      />
    </>
  );
}
