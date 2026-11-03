import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { formatDateTimeIST, renderTemplate, templateValues, whatsappDigits, whatsappLink, type DateFormat, type WhatsAppContext } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import { useDateFormat, useRealtimeInvalidate } from "../hooks/data";
import { Alert, Badge, Button, Field, Modal, Select, Spinner, Textarea } from "./ui";

export interface MessageTemplate {
  key: string;
  label: string;
  body: string;
  sort_order: number;
  is_active: boolean;
  version: number;
}

export interface WhatsAppLogRow {
  id: string;
  job_id: string | null;
  job_no: string | null;
  part_label: string | null;
  vendor_id: string;
  vendor_name: string;
  template_key: string | null;
  template_label: string | null;
  phone: string;
  body: string;
  status: "opened" | "user_confirmed_sent";
  created_at: string;
  opened_by_name: string | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
}

type Context = WhatsAppContext & {
  job_id: string;
  vendor_id: string;
  assignment_state: string;
  wa_country_code: string;
  wa_number: string | null;
  mobile: string | null;
  recent: Array<{ id: string; template_key: string | null; created_at: string; status: string; opened_by_name: string | null }>;
};

export function useTemplates() {
  useRealtimeInvalidate(["message_templates"], ["message-templates"]);
  return useQuery({
    queryKey: ["message-templates"],
    queryFn: async () => unwrap(await supabase.from("message_templates").select("*").order("sort_order")) as MessageTemplate[],
    staleTime: 60_000,
  });
}

/** The template that fits the job's situation (the user can pick another). */
export function suggestTemplate(status: string | null | undefined, opts: { payment?: boolean; reminder?: string; rejected?: number; hasCommitment?: boolean } = {}): string {
  if (opts.payment) return "payment_confirmation";
  if (opts.reminder === "upcoming") return "upcoming_reminder";
  if (opts.reminder === "due_today") return "due_today";
  if (opts.reminder === "overdue") return "overdue";
  switch (status) {
    case "Overdue":
      return "overdue";
    case "Due Today":
      return "due_today";
    case "Due Soon":
      return "upcoming_reminder";
    case "Partially Returned":
      return "return_reminder";
    case "Commitment Date Missing":
      return "new_job";
    case "Sent to Vendor":
      return opts.hasCommitment ? "commitment_confirmation" : "new_job";
    case "Completed":
      return opts.rejected ? "quality_followup" : "status_followup";
    default:
      return "status_followup";
  }
}

export function WhatsAppDialog({ jobId, paymentId, initialTemplate, open, onClose }: { jobId: string; paymentId?: string; initialTemplate: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const dateFormat = useDateFormat();
  const templates = useTemplates();
  const ctx = useQuery({
    queryKey: ["whatsapp-context", jobId, paymentId ?? null],
    enabled: open,
    queryFn: async () => unwrap(await supabase.rpc("whatsapp_context", { p_job_id: jobId, p_payment_id: paymentId ?? null })) as Context,
  });
  const [templateKey, setTemplateKey] = useState(initialTemplate);
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) {
      setTemplateKey(initialTemplate);
      setEdited(false);
      setError(null);
      setDuplicate(null);
      setOpenedId(null);
      setConfirmed(false);
    }
  }, [open, initialTemplate]);

  const template = templates.data?.find((t) => t.key === templateKey);
  const rendered = useMemo(() => (template && ctx.data ? renderTemplate(template.body, templateValues(ctx.data, dateFormat)) : null), [template, ctx.data, dateFormat]);
  useEffect(() => {
    if (rendered && !edited) setText(rendered.text);
  }, [rendered, edited]);

  const c = ctx.data;
  const digits = c ? whatsappDigits(c.wa_country_code, c.wa_number ?? c.mobile) : null;
  const stillMissing = /\[missing: /.test(text);

  async function openWhatsApp(confirmDuplicate: boolean) {
    if (!c || !digits) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc("log_whatsapp_message", {
        p_vendor_id: c.vendor_id,
        p_job_id: jobId,
        p_template_key: templateKey,
        p_phone: digits,
        p_body: text,
        p_confirm_duplicate: confirmDuplicate,
      });
      if (err) {
        if (err.code === "PT409") {
          setDuplicate(err.message);
          return;
        }
        throw err;
      }
      setDuplicate(null);
      setOpenedId((data as { id: string }).id);
      window.open(whatsappLink(digits, text), "_blank", "noopener,noreferrer");
      await Promise.all([qc.invalidateQueries({ queryKey: ["whatsapp-context", jobId] }), qc.invalidateQueries({ queryKey: ["whatsapp-log"] }), qc.invalidateQueries({ queryKey: ["job-activity", jobId] })]);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      wide
      title={c ? `WhatsApp to ${c.vendor_name}` : "WhatsApp"}
      onClose={onClose}
      footer={
        openedId ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {!confirmed && (
              <Button
                onClick={async () => {
                  try {
                    unwrap(await supabase.rpc("confirm_whatsapp_sent", { p_message_id: openedId }));
                    setConfirmed(true);
                    await qc.invalidateQueries({ queryKey: ["whatsapp-log"] });
                  } catch (e) {
                    setError(toAppError(e).message);
                  }
                }}
              >
                I pressed Send in WhatsApp
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {duplicate ? (
              <Button variant="danger" loading={busy} onClick={() => void openWhatsApp(true)}>
                Open again anyway
              </Button>
            ) : (
              <Button loading={busy} disabled={!digits || !text.trim()} onClick={() => void openWhatsApp(false)}>
                <MessageCircle className="h-4 w-4" /> Open WhatsApp
              </Button>
            )}
          </>
        )
      }
    >
      {ctx.isLoading || templates.isLoading ? (
        <Spinner />
      ) : ctx.error ? (
        <Alert tone="error">{toAppError(ctx.error).message}</Alert>
      ) : openedId ? (
        <>
          <Alert tone="info" title="WhatsApp was opened with your message">
            Check the message and press <strong>Send</strong> in WhatsApp. This app cannot see whether WhatsApp sent or delivered it, so it is recorded as
            "opened". After you have sent it, you can mark it here.
          </Alert>
          {confirmed && <Alert tone="success">Marked as sent by you.</Alert>}
          <p className="text-xs text-slate-500">If WhatsApp did not open (pop-ups blocked), allow pop-ups for this site and use "Open WhatsApp" again.</p>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Message" htmlFor="wa-template">
              <Select
                id="wa-template"
                value={templateKey}
                onChange={(e) => {
                  setTemplateKey(e.target.value);
                  setEdited(false);
                }}
              >
                {(templates.data ?? [])
                  .filter((t) => t.is_active)
                  .map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <div>
              <p className="text-sm font-medium text-slate-700">To</p>
              {digits ? (
                <p className="mt-2 text-sm text-slate-900">
                  {c?.contact_person ? `${c.contact_person}, ` : ""}
                  {c?.vendor_name} · +{digits}
                </p>
              ) : (
                <Alert tone="warning">
                  No valid WhatsApp or mobile number for this vendor.{" "}
                  <Link className="underline" to={`/vendors/${c?.vendor_id}`}>
                    Add it on the vendor page
                  </Link>
                  .
                </Alert>
              )}
            </div>
          </div>
          <Field label="Text (you can edit it before opening WhatsApp)" htmlFor="wa-text">
            <Textarea
              id="wa-text"
              rows={7}
              value={text}
              maxLength={4000}
              onChange={(e) => {
                setText(e.target.value);
                setEdited(true);
              }}
            />
          </Field>
          {stillMissing && <Alert tone="warning">Some facts are not recorded for this job ([missing: ...]). Fill them in or remove them before sending.</Alert>}
          {rendered?.unknown.length ? <Alert tone="warning">The template has unknown placeholders: {rendered.unknown.map((u) => `{${u}}`).join(", ")}. Fix the template in Settings.</Alert> : null}
          {duplicate && <Alert tone="warning" title="Already opened recently">{duplicate}</Alert>}
          {c && c.recent.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recent WhatsApp for this job</p>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {c.recent.slice(0, 5).map((m) => (
                  <li key={m.id}>
                    {formatDateTimeIST(m.created_at, dateFormat)} · {templates.data?.find((t) => t.key === m.template_key)?.label ?? "Message"} · {m.opened_by_name}{" "}
                    {m.status === "user_confirmed_sent" ? <Badge tone="green">marked sent</Badge> : <Badge>opened</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && <Alert tone="error">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}

export function WhatsAppHistory({ jobId, vendorId, dateFormat, limit = 50 }: { jobId?: string; vendorId?: string; dateFormat: DateFormat; limit?: number }) {
  useRealtimeInvalidate(["whatsapp_messages"], ["whatsapp-log", jobId ?? null, vendorId ?? null]);
  const log = useQuery({
    queryKey: ["whatsapp-log", jobId ?? null, vendorId ?? null],
    queryFn: async () => {
      let q = supabase.from("whatsapp_log").select("*").order("created_at", { ascending: false }).limit(limit);
      if (jobId) q = q.eq("job_id", jobId);
      if (vendorId) q = q.eq("vendor_id", vendorId);
      return unwrap(await q) as WhatsAppLogRow[];
    },
  });
  if (log.isLoading) return <Spinner />;
  if (log.error) return <Alert tone="error">{toAppError(log.error).message}</Alert>;
  if (!log.data?.length) return <p className="text-sm text-slate-600">No WhatsApp messages yet.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {log.data.map((m) => (
        <li key={m.id} className="py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-800">{m.template_label ?? "Message"}</span>
            {m.status === "user_confirmed_sent" ? <Badge tone="green">Marked as sent by {m.confirmed_by_name}</Badge> : <Badge>Opened in WhatsApp (not confirmed)</Badge>}
          </div>
          <p className="text-xs text-slate-500">
            {formatDateTimeIST(m.created_at, dateFormat)} · {m.opened_by_name} · {m.vendor_name} +{m.phone}
            {!jobId && m.job_id && (
              <>
                {" "}
                ·{" "}
                <Link to={`/jobs/${m.job_id}`} className="text-brand-700 hover:underline">
                  {m.job_no}
                </Link>
              </>
            )}
          </p>
          <p className="mt-0.5 whitespace-pre-line text-xs text-slate-700">{m.body}</p>
        </li>
      ))}
    </ul>
  );
}
