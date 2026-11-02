// Backup encryption: AES-256-GCM with a 256-bit key kept in a separate key file.
// File format: "CESSBAK1" (8 bytes) | key id (8 bytes) | IV (12 bytes) | ciphertext | auth tag (16 bytes)
// The auth tag makes any change to the file (tampering, disk corruption) detectable.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";

const MAGIC = Buffer.from("CESSBAK1", "ascii");
const HEADER_LENGTH = MAGIC.length + 8 + 12;
const TAG_LENGTH = 16;

export class BackupKeyError extends Error {}
export class BackupIntegrityError extends Error {}

export function generateKey(): Buffer {
  return randomBytes(32);
}

export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function encodeKey(key: Buffer): string {
  return key.toString("base64");
}

export async function loadKey(file: string): Promise<Buffer> {
  let text: string;
  try {
    text = (await readFile(file, "utf8")).trim();
  } catch {
    throw new BackupKeyError(`Backup key file not found: ${file}. Run "setup" or restore your saved copy of the key.`);
  }
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new BackupKeyError(`Backup key file is not valid (expected a 32-byte base64 key): ${file}`);
  return key;
}

/** Encrypts the source into a NEW file (never overwrites: fails if the file exists). */
export async function encryptToFile(source: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>, outPath: string, key: Buffer): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const fh = await open(outPath, "wx");
  try {
    await fh.write(Buffer.concat([MAGIC, Buffer.from(keyId(key), "hex"), iv]));
    for await (const chunk of source) {
      const enc = cipher.update(chunk);
      if (enc.length) await fh.write(enc);
    }
    const fin = cipher.final();
    if (fin.length) await fh.write(fin);
    await fh.write(cipher.getAuthTag());
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Reads the key id stored in a backup file header (to give a clear "wrong key" message). */
export async function readKeyId(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const header = Buffer.alloc(HEADER_LENGTH);
    await fh.read(header, 0, HEADER_LENGTH, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupIntegrityError("Not a CESS backup file (bad header).");
    return header.subarray(MAGIC.length, MAGIC.length + 8).toString("hex");
  } finally {
    await fh.close();
  }
}

/**
 * Decrypts a backup file as a stream. Data is only trustworthy once the generator finishes without error:
 * the authentication tag is checked at the end, so callers must not commit anything before then.
 */
export async function* decryptFile(path: string, key: Buffer): AsyncGenerator<Buffer> {
  const { size } = await stat(path);
  if (size < HEADER_LENGTH + TAG_LENGTH) throw new BackupIntegrityError("Backup file is too small to be valid.");
  const fileKeyId = await readKeyId(path);
  if (fileKeyId !== keyId(key)) {
    throw new BackupKeyError(`This backup was made with a different key (key id ${fileKeyId}, yours is ${keyId(key)}).`);
  }
  const fh = await open(path, "r");
  const iv = Buffer.alloc(12);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    await fh.read(iv, 0, 12, MAGIC.length + 8);
    await fh.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  if (size - TAG_LENGTH - 1 >= HEADER_LENGTH) {
    for await (const chunk of createReadStream(path, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 })) {
      const out = decipher.update(chunk as Buffer);
      if (out.length) yield out;
    }
  }
  try {
    const fin = decipher.final();
    if (fin.length) yield fin;
  } catch {
    throw new BackupIntegrityError("Backup file failed the integrity check (it was changed or is corrupted).");
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
