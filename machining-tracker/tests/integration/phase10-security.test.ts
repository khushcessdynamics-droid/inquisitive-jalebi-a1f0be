// Phase 10 final security acceptance tests that were not yet covered by earlier phases:
//   5  passwords are never stored in plain text
//   6  uploaded files cannot be reached through public URLs
//   7  expired signed file links stop working
//  11  two people saving at the same time: different jobs both persist; the same job cannot be silently overwritten
// (Example 9). The others are covered in foundation/jobs/phase6/phase10-restore tests and tools/deploy-check.
// Test 4 (failed sign-ins) is a limit of Supabase's hosted platform that the local stack does not have: it is checked
// against the live project by tools/deploy-check/verify.mjs --check-login-limit, and the sign-in page's message by e2e.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { localEnv } from "../helpers/env";
import { PASSWORD, closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const env = localEnv();
let manager: SupabaseClient;
let manager2: SupabaseClient;
const managerEmail = uniqueEmail("p10s.mgr");
const manager2Email = uniqueEmail("p10s.mgr2");
let cnc = "";

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as NonNullable<T>;
}
async function asManager(email: string, name: string): Promise<SupabaseClient> {
  const id = await createAuthUser(email, name);
  await sql("update public.profiles set role_key = 'manager', is_active = true, full_name = $2 where id = $1", [id, name]);
  const c = await signIn(email);
  await enrollAndVerifyMfa(c);
  return c;
}

beforeAll(async () => {
  await resetLocalDatabase();
  manager = await asManager(managerEmail, "Mona Manager");
  manager2 = await asManager(manager2Email, "Vikram Manager");
  cnc = (await sql<{ id: string }>("select id from public.work_categories where name = 'CNC Turning'"))[0]!.id;
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("passwords and files", () => {
  it("5: passwords are stored only as salted bcrypt hashes", async () => {
    const rows = await sql<{ h: string }>("select encrypted_password as h from auth.users where email in ($1, $2)", [managerEmail, manager2Email]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.h).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
      expect(r.h).not.toContain(PASSWORD);
    }
    expect(rows[0]!.h).not.toBe(rows[1]!.h); // same password, different salt
    // no application table holds a copy of the password
    const hits = await sql<{ n: number }>(
      `select count(*)::int as n from public.profiles p where p::text like '%' || $1 || '%'`,
      [PASSWORD],
    );
    expect(hits[0]!.n).toBe(0);
  });

  it("6 and 7: attachments have no public URL, need a signed link, and the link stops working when it expires", async () => {
    const job = (await ok(manager.rpc("create_job", { p: { part_label: "Secret drawing part", category_id: cnc } }))) as Json;
    const path = `${job.id}/${crypto.randomUUID()}__drawing.pdf`;
    expect((await manager.storage.from("job-files").upload(path, new Blob(["%PDF-1.4 confidential"]), { contentType: "application/pdf" })).error).toBeNull();
    await ok(manager.rpc("register_attachment", { p_job_id: job.id, p_storage_path: path, p_file_name: "drawing.pdf" }));
    const encoded = path.split("/").map(encodeURIComponent).join("/");

    // public URL form, anonymous request, and the public key alone: all refused
    const pub = await fetch(`${env.apiUrl}/storage/v1/object/public/job-files/${encoded}`);
    expect(pub.ok).toBe(false);
    expect(await pub.text()).not.toContain("confidential");
    const anon = await fetch(`${env.apiUrl}/storage/v1/object/job-files/${encoded}`);
    expect(anon.ok).toBe(false);
    const withKey = await fetch(`${env.apiUrl}/storage/v1/object/authenticated/job-files/${encoded}`, {
      headers: { apikey: env.publishableKey, Authorization: `Bearer ${env.publishableKey}` },
    });
    expect(withKey.ok).toBe(false);
    expect((await sql<{ public: boolean }>("select public from storage.buckets where id = 'job-files'"))[0]!.public).toBe(false);

    // a signed link works only until it expires
    const signed = await manager.storage.from("job-files").createSignedUrl(path, 2);
    expect(signed.error).toBeNull();
    const now = await fetch(signed.data!.signedUrl);
    expect(await now.text()).toBe("%PDF-1.4 confidential");
    await new Promise((r) => setTimeout(r, 3500));
    const later = await fetch(signed.data!.signedUrl);
    expect(later.ok).toBe(false);
    expect(await later.text()).not.toContain("confidential");
  });
});

describe("Example 9 / test 11: two people working at the same time", () => {
  it("simultaneous saves on different jobs both persist", async () => {
    const make = async (part: string) => (await ok(manager.rpc("create_job", { p: { part_label: part, category_id: cnc } }))) as Json;
    const [a, b] = await Promise.all([make("Job for Mona"), make("Job for Vikram")]);
    const va = ((await ok(manager.from("jobs").select("version").eq("id", a.id).single())) as Json).version;
    const vb = ((await ok(manager2.from("jobs").select("version").eq("id", b.id).single())) as Json).version;
    const [ra, rb] = await Promise.all([
      manager.rpc("update_job", { p_job_id: a.id, p_expected_version: va, p: { remarks: "Mona's change" } }),
      manager2.rpc("update_job", { p_job_id: b.id, p_expected_version: vb, p: { remarks: "Vikram's change" } }),
    ]);
    expect(ra.error).toBeNull();
    expect(rb.error).toBeNull();
    const rows = (await ok(manager.from("jobs").select("id, remarks").in("id", [a.id, b.id]))) as Json[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.remarks]))).toEqual({ [a.id]: "Mona's change", [b.id]: "Vikram's change" });
  });

  it("simultaneous saves on the same job: exactly one wins, the other is told to reload, nothing is silently lost", async () => {
    const job = (await ok(manager.rpc("create_job", { p: { part_label: "Shared job", category_id: cnc } }))) as Json;
    const v = ((await ok(manager.from("jobs").select("version").eq("id", job.id).single())) as Json).version;
    const results = await Promise.all([
      manager.rpc("update_job", { p_job_id: job.id, p_expected_version: v, p: { remarks: "from Mona" } }),
      manager2.rpc("update_job", { p_job_id: job.id, p_expected_version: v, p: { remarks: "from Vikram" } }),
    ]);
    const okCount = results.filter((r) => !r.error).length;
    expect(okCount).toBe(1);
    const loser = results.find((r) => r.error)!;
    expect(loser.error!.code).toBe("PT409");
    const winner = results[0]!.error ? "from Vikram" : "from Mona";
    const row = (await ok(manager.from("jobs").select("remarks, version").eq("id", job.id).single())) as Json;
    expect(row).toMatchObject({ remarks: winner, version: v + 1 });
    // the history records exactly the one saved change
    const log = await sql<{ n: number }>("select count(*)::int as n from public.activity_log where entity_id = $1 and action = 'job.updated'", [job.id]);
    expect(log[0]!.n).toBe(1);
  });
});
