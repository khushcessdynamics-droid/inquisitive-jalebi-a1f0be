// Converts Supabase / PostgREST / Auth errors into plain messages for office users.
export class AppError extends Error {
  constructor(
    message: string,
    public readonly kind: "conflict" | "forbidden" | "validation" | "network" | "not_found" | "unknown" = "unknown",
  ) {
    super(message);
  }
}

type AnyError = { message?: string; code?: string; status?: number; details?: string; hint?: string } | null | undefined;

/**
 * Raw database / API wording that would reveal internal table, column, constraint or function names.
 * Messages written by the app's own database rules never contain these.
 */
const INTERNAL_DETAIL =
  /relation "|column "|constraint "|syntax error|permission denied for (table|function|schema|sequence|view|relation)|function \S+\(.*\) does not exist|schema "|violates|stack|at line \d|PL\/pgSQL|SQL statement|JWT|PGRST/i;
const FORMAT_CODES = new Set(["23514", "23502", "22P02", "22001", "22003", "22007", "22008"]);

export function serverErrorText(code: string): string {
  return `Something went wrong on the server. Please try again; if it keeps happening, tell the administrator (error code ${code || "unknown"}).`;
}

/**
 * Only messages written for users are shown as they are: the app's own database rules (codes 22023, 42501, P0002,
 * PT409, P0001), Supabase Auth messages and the app's own texts. Raw database errors are replaced by a plain message
 * with the error code, so internal names never reach the screen (security acceptance test 15).
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = (err ?? {}) as NonNullable<AnyError>;
  const code = e.code ?? "";
  const message = e.message ?? (err instanceof Error ? err.message : "Something went wrong.");
  const internal = INTERNAL_DETAIL.test(message);
  if (code === "PT409") return new AppError(internal ? "This record was changed by someone else. Reload and try again." : message, "conflict");
  if (code === "42501" || e.status === 403) {
    return new AppError(!message || internal ? "You do not have permission for this action." : message, "forbidden");
  }
  if (code === "22023") return new AppError(internal ? "A value is not allowed. Check the entries and try again." : message, "validation");
  if (code === "23505") return new AppError("This name or value already exists.", "validation");
  if (FORMAT_CODES.has(code)) return new AppError("A value is missing, too long or in the wrong format. Check the entries and try again.", "validation");
  if (code === "23503") return new AppError("This record is linked to other records, so it cannot be changed this way.", "validation");
  if (code === "PGRST116") return new AppError("Record not found.", "not_found");
  if (code === "P0002") return new AppError(!message || internal ? "Record not found." : message, "not_found");
  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return new AppError("Cannot reach the server. Check your internet connection and try again.", "network");
  }
  if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303" || e.status === 401) {
    return new AppError("Your session has ended. Please sign in again.", "forbidden");
  }
  const sqlState = /^[0-9A-Z]{5}$/.test(code) && code !== "P0001";
  if (sqlState || code.startsWith("PGRST") || (e.status ?? 0) >= 500 || internal) {
    return new AppError(serverErrorText(code || (e.status ? String(e.status) : "")), "unknown");
  }
  return new AppError(message, "unknown");
}

/** Throws a friendly AppError if a Supabase call returned an error; otherwise returns data. */
export function unwrap<T>(result: { data: T; error: AnyError | unknown }): T {
  if (result.error) throw toAppError(result.error);
  return result.data;
}
