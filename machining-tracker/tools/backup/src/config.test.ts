import { describe, expect, it } from "vitest";
import { parseConfig, redact, syncedFolderReason } from "./config.ts";

const base = {
  projectLabel: "abc",
  supabaseUrl: "https://abc.supabase.co",
  databaseUrl: "postgresql://postgres.abc:S3cret!pass@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
  sslRootCert: "config/ca.crt",
  serviceKey: "sb_secret_abcdef",
};

describe("backup configuration", () => {
  it("refuses data or backup folders inside OneDrive / Google Drive / Dropbox", () => {
    expect(syncedFolderReason("C:\\Users\\nityam\\OneDrive\\CESS")).not.toBeNull();
    expect(syncedFolderReason("C:\\Users\\nityam\\OneDrive - CESS Dynamics\\Backups")).not.toBeNull();
    expect(syncedFolderReason("G:\\My Drive\\CESS")).not.toBeNull();
    expect(syncedFolderReason("/home/x/Dropbox/cess")).not.toBeNull();
    expect(syncedFolderReason("C:\\Users\\nityam\\CESS-Machining-Data")).toBeNull();
    expect(() => parseConfig({ ...base, backupDir: "/home/x/Dropbox/cess" }, "/home/x/CESS-Machining-Data")).toThrow(/synced folder/);
  });

  it("requires HTTPS and certificate checking for the hosted project", () => {
    expect(() => parseConfig({ ...base, sslRootCert: "" }, "/data")).toThrow(/sslRootCert/);
    expect(() => parseConfig({ ...base, supabaseUrl: "http://abc.supabase.co" }, "/data")).toThrow(/https/);
    const cfg = parseConfig(base, "/data");
    expect(cfg.retention).toEqual({ daily: 14, weekly: 8, monthly: 12, minVerified: 3 });
    expect(cfg.backupDir).toMatch(/backups$/);
  });

  it("never prints the database password or secret key", () => {
    const cfg = parseConfig(base, "/data");
    const text = `failed to connect ${base.databaseUrl} with key ${base.serviceKey} (password S3cret!pass)`;
    const out = redact(text, cfg);
    expect(out).not.toContain("S3cret!pass");
    expect(out).not.toContain("sb_secret_abcdef");
  });
});
