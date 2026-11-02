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

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = (err ?? {}) as NonNullable<AnyError>;
  const code = e.code ?? "";
  const message = e.message ?? (err instanceof Error ? err.message : "Something went wrong.");
  if (code === "PT409") return new AppError(message, "conflict");
  if (code === "42501" || e.status === 403) return new AppError(message || "You do not have permission for this action.", "forbidden");
  if (code === "22023" || code === "23514" || code === "22P02") return new AppError(message, "validation");
  if (code === "23505") return new AppError("This name or value already exists.", "validation");
  if (code === "P0002" || code === "PGRST116") return new AppError(message || "Record not found.", "not_found");
  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return new AppError("Cannot reach the server. Check your internet connection and try again.", "network");
  }
  return new AppError(message, "unknown");
}

/** Throws a friendly AppError if a Supabase call returned an error; otherwise returns data. */
export function unwrap<T>(result: { data: T; error: AnyError | unknown }): T {
  if (result.error) throw toAppError(result.error);
  return result.data;
}
