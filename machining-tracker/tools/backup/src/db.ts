import { readFileSync } from "node:fs";
import pg from "pg";
import copyStreams from "pg-copy-streams";
import type { BackupConfig } from "./config.ts";

export type Db = pg.Client;

/** Connects as the database owner. For the hosted project the server certificate is verified against the Supabase CA. */
export async function connect(cfg: Pick<BackupConfig, "databaseUrl" | "sslRootCert">): Promise<Db> {
  const url = new URL(cfg.databaseUrl);
  url.searchParams.delete("sslmode");
  const ssl = cfg.sslRootCert ? { ca: readFileSync(cfg.sslRootCert, "utf8"), rejectUnauthorized: true } : undefined;
  const client = new pg.Client({ connectionString: url.toString(), ssl, application_name: "cess-backup" });
  await client.connect();
  return client;
}

export async function copyOut(client: Db, sql: string): Promise<Buffer> {
  const stream = client.query(copyStreams.to(sql));
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function copyIn(client: Db, sql: string, data: Buffer): Promise<void> {
  const stream = client.query(copyStreams.from(sql));
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    stream.end(data);
  });
}
