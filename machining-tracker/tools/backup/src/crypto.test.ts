import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackupIntegrityError, BackupKeyError, decryptFile, encryptToFile, generateKey } from "./crypto.ts";
import { createArchiveWriter, readArchive } from "./archive.ts";

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(p);
  return Buffer.concat(parts);
}

describe("backup encryption", () => {
  it("round-trips data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cess-crypto-"));
    const key = generateKey();
    const data = Buffer.from("Part 4711 / Shaft;CNC Turning;₹12,500\n".repeat(1000));
    await encryptToFile([data], join(dir, "a.cbk"), key);
    const file = await readFile(join(dir, "a.cbk"));
    expect(file.includes(Buffer.from("Shaft"))).toBe(false); // nothing readable in the file
    expect(await collect(decryptFile(join(dir, "a.cbk"), key))).toEqual(data);
  });

  it("detects any changed byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cess-crypto-"));
    const key = generateKey();
    await encryptToFile([Buffer.alloc(5000, 7)], join(dir, "a.cbk"), key);
    const bytes = await readFile(join(dir, "a.cbk"));
    bytes[100] = bytes[100]! ^ 1;
    await writeFile(join(dir, "b.cbk"), bytes);
    await expect(collect(decryptFile(join(dir, "b.cbk"), key))).rejects.toBeInstanceOf(BackupIntegrityError);
  });

  it("refuses the wrong key with a clear error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cess-crypto-"));
    await encryptToFile([Buffer.from("x")], join(dir, "a.cbk"), generateKey());
    await expect(collect(decryptFile(join(dir, "a.cbk"), generateKey()))).rejects.toBeInstanceOf(BackupKeyError);
  });

  it("never overwrites an existing backup file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cess-crypto-"));
    const key = generateKey();
    await encryptToFile([Buffer.from("first")], join(dir, "a.cbk"), key);
    await expect(encryptToFile([Buffer.from("second")], join(dir, "a.cbk"), key)).rejects.toThrow(/EEXIST/);
    expect((await collect(decryptFile(join(dir, "a.cbk"), key))).toString()).toBe("first");
  });
});

describe("archive container", () => {
  it("keeps entry order and content, including binary files", async () => {
    const w = createArchiveWriter();
    const chunks: Buffer[] = [];
    const reading = (async () => {
      for await (const c of w.output) chunks.push(c as Buffer);
    })();
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await w.add("manifest.json", Buffer.from("{}"));
    await w.add("files/b/drawing 1.dxf", binary);
    w.finish();
    await reading;
    const seen: Array<[string, Buffer]> = [];
    await readArchive([Buffer.concat(chunks)], async (n, d) => {
      seen.push([n, d]);
    });
    expect(seen.map((s) => s[0])).toEqual(["manifest.json", "files/b/drawing 1.dxf"]);
    expect(seen[1]![1]).toEqual(binary);
  });
});
