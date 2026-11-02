// Supabase Storage (attachments) access with the secret key. Used only on the backup PC.
import type { BackupConfig } from "./config.ts";
import type { BucketMeta } from "./manifest.ts";

type Cfg = Pick<BackupConfig, "supabaseUrl" | "serviceKey">;

function headers(cfg: Cfg, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: cfg.serviceKey, ...extra };
  if (cfg.serviceKey.startsWith("eyJ")) h.Authorization = `Bearer ${cfg.serviceKey}`;
  return h;
}

function objectUrl(cfg: Cfg, bucket: string, name: string): string {
  return `${cfg.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export async function downloadObject(cfg: Cfg, bucket: string, name: string): Promise<Buffer> {
  const res = await fetch(objectUrl(cfg, bucket, name), { headers: headers(cfg) });
  if (!res.ok) throw new Error(`Could not download ${bucket}/${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function uploadObject(cfg: Cfg, bucket: string, name: string, data: Buffer, contentType: string | null): Promise<void> {
  const res = await fetch(objectUrl(cfg, bucket, name), {
    method: "POST",
    headers: headers(cfg, { "x-upsert": "true", "Content-Type": contentType ?? "application/octet-stream" }),
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`Could not upload ${bucket}/${name}: HTTP ${res.status} ${await res.text()}`);
}

export async function ensureBucket(cfg: Cfg, bucket: BucketMeta): Promise<"exists" | "created"> {
  const get = await fetch(`${cfg.supabaseUrl}/storage/v1/bucket/${encodeURIComponent(bucket.id)}`, { headers: headers(cfg) });
  if (get.ok) return "exists";
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: headers(cfg, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      file_size_limit: bucket.file_size_limit,
      allowed_mime_types: bucket.allowed_mime_types,
    }),
  });
  if (!res.ok) throw new Error(`Could not create bucket ${bucket.id}: HTTP ${res.status} ${await res.text()}`);
  return "created";
}
