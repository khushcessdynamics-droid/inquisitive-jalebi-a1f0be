// Edit dialogs work on the record AS IT WAS WHEN THE DIALOG OPENED. If someone else saves the same record meanwhile (it arrives
// through the live updates), the user's typing is kept, a notice explains what happened, and the save is sent with the version
// the user started from, so the server refuses it ("changed by someone else") instead of overwriting the other person's change.
import { useState } from "react";
import { Alert } from "../components/ui";

/** The value captured when `open` became true; while closed it simply follows `value`. */
export function useOpenSnapshot<T>(open: boolean, value: T): T {
  const [snap, setSnap] = useState({ open, value });
  if (open !== snap.open) setSnap({ open, value }); // React's "adjust state while rendering" pattern
  return open && snap.open ? snap.value : value;
}

/** True when the record has a newer saved version than the one the dialog opened with. */
export function changedSince(snapshot: { version?: number } | null | undefined, current: { version?: number } | null | undefined): boolean {
  return !!snapshot && !!current && snapshot.version !== undefined && current.version !== undefined && snapshot.version !== current.version;
}

export function ChangedMeanwhileNotice({ show, what = "this record" }: { show: boolean; what?: string }) {
  if (!show) return null;
  return (
    <Alert tone="warning" title="Changed by someone else">
      Someone else saved {what} while you were editing. Your typing is kept here, but saving will be refused so that their change is not
      overwritten. Copy anything you need, close this window and open it again to see the latest version.
    </Alert>
  );
}
