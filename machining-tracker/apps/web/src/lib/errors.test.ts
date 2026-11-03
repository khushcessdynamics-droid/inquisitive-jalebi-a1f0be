import { describe, expect, it } from "vitest";
import { AppError, toAppError } from "./errors";

describe("error messages shown to users (security acceptance test 15)", () => {
  it("shows the app's own rule messages unchanged", () => {
    expect(toAppError({ code: "22023", message: "Quantity received cannot be more than the 40 still with the vendor." })).toMatchObject({
      kind: "validation",
      message: "Quantity received cannot be more than the 40 still with the vendor.",
    });
    expect(toAppError({ code: "42501", message: "You do not have permission for this action (payments.manage)." }).message).toBe(
      "You do not have permission for this action (payments.manage).",
    );
    expect(toAppError({ code: "PT409", message: "This job was changed by Mona Manager. Reload and try again." }).kind).toBe("conflict");
    expect(toAppError({ code: "P0002", message: "Job not found." }).message).toBe("Job not found.");
    expect(toAppError({ code: "P0001", message: "The last active Admin cannot be deactivated." }).message).toBe("The last active Admin cannot be deactivated.");
  });

  it("never shows internal table, column, constraint or function names", () => {
    const raw = [
      { code: "42501", message: "permission denied for table vendor_payments" },
      { code: "42501", message: "permission denied for function dashboard_data" },
      { code: "23514", message: 'new row for relation "jobs" violates check constraint "jobs_qty_sent_check"' },
      { code: "23502", message: 'null value in column "vendor_id" of relation "job_assignments" violates not-null constraint' },
      { code: "23503", message: 'insert or update on table "jobs" violates foreign key constraint "jobs_category_id_fkey"' },
      { code: "42703", message: 'column jobs.secret does not exist' },
      { code: "42P01", message: 'relation "public.missing" does not exist' },
      { code: "XX000", message: "internal error at line 12 of PL/pgSQL function private.run_reminders" },
      { code: "PGRST204", message: "Could not find the 'x' column of 'jobs' in the schema cache" },
      { code: "22023", message: 'invalid input value for enum "job_state": "x" at line 3' },
      { status: 500, message: "upstream connect error" },
      new Error('duplicate key value violates unique constraint "vendors_name_key"'),
    ];
    for (const r of raw) {
      const shown = toAppError(r).message;
      expect(shown).not.toMatch(/vendor_payments|dashboard_data|relation|constraint|column|PL\/pgSQL|schema cache|enum|upstream|vendors_name_key/i);
    }
    expect(toAppError({ code: "42703", message: "column jobs.secret does not exist" }).message).toBe(
      "Something went wrong on the server. Please try again; if it keeps happening, tell the administrator (error code 42703).",
    );
    expect(toAppError({ code: "23505", message: 'duplicate key value violates unique constraint "vendors_name_key"' }).message).toBe(
      "This name or value already exists.",
    );
    expect(toAppError({ code: "42501", message: "permission denied for table jobs" }).message).toBe("You do not have permission for this action.");
  });

  it("keeps sign-in messages, network problems and the app's own texts readable", () => {
    expect(toAppError({ status: 400, code: "invalid_credentials", message: "Invalid login credentials" }).message).toBe("Invalid login credentials");
    expect(toAppError(new TypeError("Failed to fetch")).kind).toBe("network");
    expect(toAppError(new Error("Choose a password different from the previous one.")).message).toBe("Choose a password different from the previous one.");
    expect(toAppError({ code: "PGRST303", message: "JWT expired", status: 401 }).message).toBe("Your session has ended. Please sign in again.");
    const own = new AppError("This template was changed by someone else.", "conflict");
    expect(toAppError(own)).toBe(own);
  });
});
