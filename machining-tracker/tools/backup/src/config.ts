// Backup tool configuration, stored on the PC (never in Git):
//   <data dir>\config\backup.json   - connection details (contains secrets; keep this folder private)
//   <data dir>\keys\backup.key       - encryption key (keep a second copy somewhere safe!)
// Default data dir: %USERPROFILE%\CESS-Machining-Data (override with CESS_DATA_DIR).
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";

export interface RetentionSettings {
  daily: number;
  weekly: number;
  monthly: number;
  minVerified: number;
}

export interface BackupConfig {
  dataDir: string;
  backupDir: string;
  secondCopyDir: string | null;
  keyFile: string;
  logDir: string;
  databaseUrl: string;
  sslRootCert: string | null;
  supabaseUrl: string;
  serviceKey: string;
  projectLabel: string;
  machineLabel: string;
  retention: RetentionSettings;
}

export class ConfigError extends Error {}

export function defaultDataDir(): string {
  return resolve(process.env.CESS_DATA_DIR ?? join(homedir(), "CESS-Machining-Data"));
}

export function configPath(dataDir = defaultDataDir()): string {
  return join(dataDir, "config", "backup.json");
}

/** Folders kept in sync by cloud-drive apps (a live working folder must not be in one). */
export function syncedFolderReason(path: string): string | null {
  const p = resolve(path);
  const lower = p.toLowerCase();
  for (const env of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]) {
    const root = process.env[env];
    if (root && lower.startsWith(resolve(root).toLowerCase())) return `inside OneDrive (${root})`;
  }
  const parts = lower.split(/[\\/]+/);
  for (const marker of ["onedrive", "google drive", "googledrive", "my drive", "dropbox", "icloud drive", "iclouddrive", "box sync"]) {
    if (parts.some((seg) => seg === marker || seg.startsWith(`${marker} -`) || seg.startsWith(`${marker}-`))) return `inside a "${marker}" synced folder`;
  }
  return null;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) throw new ConfigError(`backup.json: "${key}" is required.`);
  return v.trim();
}

function positiveInt(v: unknown, fallback: number, key: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1000) throw new ConfigError(`backup.json: retention.${key} must be a whole number.`);
  return v;
}

export function parseConfig(raw: unknown, dataDir: string): BackupConfig {
  if (!raw || typeof raw !== "object") throw new ConfigError("backup.json must contain a JSON object.");
  const o = raw as Record<string, unknown>;
  const abs = (p: string) => (isAbsolute(p) ? resolve(p) : resolve(dataDir, p));
  const retention = (o.retention ?? {}) as Record<string, unknown>;
  const cfg: BackupConfig = {
    dataDir,
    backupDir: abs(typeof o.backupDir === "string" && o.backupDir ? o.backupDir : "backups"),
    secondCopyDir: typeof o.secondCopyDir === "string" && o.secondCopyDir.trim() ? abs(o.secondCopyDir.trim()) : null,
    keyFile: abs(typeof o.keyFile === "string" && o.keyFile ? o.keyFile : join("keys", "backup.key")),
    logDir: abs("logs"),
    databaseUrl: requireString(o, "databaseUrl"),
    sslRootCert: typeof o.sslRootCert === "string" && o.sslRootCert.trim() ? abs(o.sslRootCert.trim()) : null,
    supabaseUrl: requireString(o, "supabaseUrl").replace(/\/+$/, ""),
    serviceKey: requireString(o, "serviceKey"),
    projectLabel: requireString(o, "projectLabel"),
    machineLabel: typeof o.machineLabel === "string" && o.machineLabel.trim() ? o.machineLabel.trim() : "this PC",
    retention: {
      daily: positiveInt(retention.daily, 14, "daily"),
      weekly: positiveInt(retention.weekly, 8, "weekly"),
      monthly: positiveInt(retention.monthly, 12, "monthly"),
      minVerified: Math.max(1, positiveInt(retention.minVerified, 3, "minVerified")),
    },
  };
  if (!/^postgres(ql)?:\/\//.test(cfg.databaseUrl)) throw new ConfigError('backup.json: "databaseUrl" must start with postgresql://');
  if (!/^https?:\/\//.test(cfg.supabaseUrl)) throw new ConfigError('backup.json: "supabaseUrl" must start with https://');
  const remote = !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.supabaseUrl);
  if (remote && !cfg.supabaseUrl.startsWith("https://")) throw new ConfigError('backup.json: "supabaseUrl" must use https://');
  if (remote && !cfg.sslRootCert) throw new ConfigError('backup.json: "sslRootCert" is required for the hosted database (download it from Supabase > Database settings > SSL).');
  for (const [label, dir] of [["data folder", cfg.dataDir], ["backup folder", cfg.backupDir]] as const) {
    const reason = syncedFolderReason(dir);
    if (reason) throw new ConfigError(`The ${label} ${dir} is ${reason}. Use a normal local folder such as C:${sep}Users${sep}<you>${sep}CESS-Machining-Data.`);
  }
  return cfg;
}

export async function loadConfig(dataDir = defaultDataDir()): Promise<BackupConfig> {
  const path = configPath(dataDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`Configuration not found: ${path}. Run the setup command first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
  return parseConfig(raw, dataDir);
}

/** Removes secrets from text before it is printed or logged. */
export function redact(text: string, cfg?: Pick<BackupConfig, "databaseUrl" | "serviceKey">): string {
  let out = text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/g, "$1***@");
  if (cfg) {
    out = out.split(cfg.serviceKey).join("***");
    const m = /:\/\/[^:]+:([^@]+)@/.exec(cfg.databaseUrl);
    if (m?.[1]) out = out.split(m[1]).join("***");
  }
  return out;
}
