#!/usr/bin/env node
// CESS Machining Tracker - backup command line. Usage: node tools/backup/src/cli.ts <command>
//   setup                          create folders, encryption key and config template (never overwrites)
//   backup [--kind manual|scheduled]
//   list
//   verify [<name>|latest]
//   restore [<name>] [--allow-schema-mismatch]
//   prune [--dry-run]
//   schedule-xml --time HH:MM --out <file> --script <backup-scheduled.cmd>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { ConfigError, configPath, defaultDataDir, loadConfig, redact, syncedFolderReason, type BackupConfig } from "./config.ts";
import { encodeKey, generateKey, keyId, loadKey } from "./crypto.ts";
import { applyRetention, listBackups, runBackup } from "./backup.ts";
import { verifyArchive } from "./verify.ts";
import { confirmationPhrase, restoreBackup } from "./restore.ts";

const CONFIG_TEMPLATE = {
  projectLabel: "<your-project-ref>",
  machineLabel: "Office PC",
  supabaseUrl: "https://<your-project-ref>.supabase.co",
  databaseUrl: "postgresql://postgres.<your-project-ref>:<DATABASE-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
  sslRootCert: "config/supabase-ca.crt",
  serviceKey: "<secret key from Supabase > Project Settings > API keys>",
  backupDir: "backups",
  secondCopyDir: "",
  retention: { daily: 14, weekly: 8, monthly: 12, minVerified: 3 },
};

function makeLogger(cfg: BackupConfig | null) {
  return (message: string) => {
    const line = `${new Date().toISOString()} ${cfg ? redact(message, cfg) : message}`;
    console.log(line);
    if (cfg) {
      try {
        mkdirSync(cfg.logDir, { recursive: true });
        appendFileSync(join(cfg.logDir, `backup-${line.slice(0, 7)}.log`), line + "\n");
      } catch {
        /* logging must never stop a backup */
      }
    }
  };
}

async function setup(): Promise<number> {
  const dataDir = defaultDataDir();
  const reason = syncedFolderReason(dataDir);
  if (reason) {
    console.error(`The data folder ${dataDir} is ${reason}. Set CESS_DATA_DIR to a normal local folder.`);
    return 1;
  }
  for (const d of ["config", "keys", "backups", "logs"]) await mkdir(join(dataDir, d), { recursive: true });
  const keyFile = join(dataDir, "keys", "backup.key");
  if (existsSync(keyFile)) {
    console.log(`Encryption key already exists (kept): ${keyFile} (key id ${keyId(await loadKey(keyFile))})`);
  } else {
    const key = generateKey();
    await writeFile(keyFile, encodeKey(key) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Created encryption key: ${keyFile} (key id ${keyId(key)})`);
    console.log("IMPORTANT: copy this key file to a USB drive or your password manager now.");
    console.log("Without it, no backup can ever be opened. Never email it or put it in Git.");
  }
  const cfgFile = configPath(dataDir);
  if (existsSync(cfgFile)) {
    console.log(`Configuration already exists (kept): ${cfgFile}`);
  } else {
    await writeFile(cfgFile, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Created configuration template: ${cfgFile}`);
    console.log("Edit it with your Supabase details (see docs/BACKUP_AND_RECOVERY.md), then run a backup.");
  }
  return 0;
}

async function pickBackup(cfg: BackupConfig, nameArg: string | undefined, rl?: ReturnType<typeof createInterface>): Promise<string | null> {
  const all = await listBackups(cfg.backupDir);
  if (!all.length) {
    console.log(`No backups found in ${cfg.backupDir}`);
    return null;
  }
  if (nameArg && nameArg !== "latest") {
    const m = all.find((b) => b.name === nameArg || b.file === nameArg);
    if (!m) throw new Error(`Backup ${nameArg} not found in ${cfg.backupDir}`);
    return m.name;
  }
  if (nameArg === "latest" || !rl) return (all.find((b) => b.status === "verified") ?? all[0]!).name;
  all.slice(0, 20).forEach((b, i) => console.log(`${String(i + 1).padStart(2)}. ${b.name}  ${b.status.toUpperCase()}  ${b.rows} rows, ${b.files} files`));
  const answer = (await rl.question("Number of the backup to use: ")).trim();
  const pick = all[Number(answer) - 1];
  return pick ? pick.name : null;
}

function scheduleXml(time: string, script: string): string {
  const [hh, mm] = time.split(":");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>CESS Machining Tracker: daily encrypted and verified backup</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T${hh}:${mm}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT30M</Interval><Count>3</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>cmd.exe</Command><Arguments>/c "${esc(script)}"</Arguments></Exec>
  </Actions>
</Task>
`;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kind: { type: "string", default: "manual" },
      "dry-run": { type: "boolean", default: false },
      "allow-schema-mismatch": { type: "boolean", default: false },
      time: { type: "string", default: "21:00" },
      out: { type: "string" },
      script: { type: "string" },
    },
  });
  const [command, arg] = positionals;

  if (command === "setup") return setup();
  if (command === "schedule-xml") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time!)) throw new Error("--time must be HH:MM (24-hour)");
    if (!values.out || !values.script) throw new Error("--out and --script are required");
    const script = /^[A-Za-z]:[\\/]/.test(values.script) ? values.script : resolve(values.script); // keep Windows paths as given
    const xml = scheduleXml(values.time!, script);
    await writeFile(values.out, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
    console.log(`Task definition written: ${values.out} (daily at ${values.time} IST, runs at next start-up if the PC was off)`);
    return 0;
  }

  const cfg = await loadConfig();
  const log = makeLogger(cfg);

  switch (command) {
    case "backup": {
      const kind = values.kind === "scheduled" ? "scheduled" : "manual";
      const r = await runBackup(cfg, kind, log);
      return r.ok ? 0 : 1;
    }
    case "list": {
      const all = await listBackups(cfg.backupDir);
      if (!all.length) console.log(`No backups in ${cfg.backupDir}`);
      for (const b of all) {
        console.log(`${b.name}  ${b.status.toUpperCase().padEnd(10)} ${(b.size_bytes / 1024 / 1024).toFixed(2)} MB  ${b.tables} tables, ${b.rows} rows, ${b.files} files`);
      }
      return 0;
    }
    case "verify": {
      const name = await pickBackup(cfg, arg ?? "latest");
      if (!name) return 1;
      const r = await verifyArchive(join(cfg.backupDir, `${name}.cbk`), await loadKey(cfg.keyFile));
      log(`Verification of ${name}: ${r.ok ? "PASSED" : "FAILED"}`);
      for (const c of r.checks) log(`  ok: ${c}`);
      for (const e of r.errors) log(`  FAILED: ${e}`);
      return r.ok ? 0 : 1;
    }
    case "prune": {
      await applyRetention(cfg.backupDir, cfg, log, values["dry-run"]);
      return 0;
    }
    case "restore": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const name = await pickBackup(cfg, arg, rl);
        if (!name) return 1;
        const sidecar = JSON.parse(await readFile(join(cfg.backupDir, `${name}.json`), "utf8")) as { created_at: string; rows: number; files: number; status: string };
        console.log("");
        console.log(`You are about to REPLACE ALL DATA in project "${cfg.projectLabel}" with backup ${name}`);
        console.log(`  taken ${sidecar.created_at}, ${sidecar.rows} rows, ${sidecar.files} attachments, status ${sidecar.status}`);
        console.log("  - the backup is verified again first; a safety backup of the current data is taken automatically");
        console.log("  - changes made after the backup was taken will be lost from the database (the safety backup keeps them)");
        console.log("  - every user will be signed out");
        const typed = await rl.question(`Type "${confirmationPhrase(cfg)}" to continue: `);
        const r = await restoreBackup(cfg, join(cfg.backupDir, `${name}.cbk`), {
          confirm: typed.trim(),
          allowSchemaMismatch: values["allow-schema-mismatch"],
          log,
        });
        return r.ok ? 0 : 1;
      } finally {
        rl.close();
      }
    }
    default:
      console.log("Commands: setup | backup [--kind manual|scheduled] | list | verify [name|latest] | restore [name] | prune [--dry-run] | schedule-xml --time HH:MM --out FILE --script FILE");
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ConfigError ? `Configuration problem: ${e.message}` : `Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
