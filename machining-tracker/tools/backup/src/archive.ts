// tar + gzip container for backup entries (streamed; no plain-text copy is written to disk).
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";

export interface ArchiveWriter {
  add(name: string, data: Buffer): Promise<void>;
  finish(): void;
  /** gzip-compressed tar stream to feed into encryption */
  output: Readable;
}

export function createArchiveWriter(): ArchiveWriter {
  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });
  pack.pipe(gzip);
  return {
    add: (name, data) =>
      new Promise((resolve, reject) => {
        pack.entry({ name, size: data.length, mtime: new Date(0), mode: 0o600 }, data, (err) => (err ? reject(err) : resolve()));
      }),
    finish: () => pack.finalize(),
    output: gzip,
  };
}

/** Calls onEntry for every entry in order. Rejects if the stream is corrupt or onEntry throws. */
export async function readArchive(source: AsyncIterable<Buffer> | Iterable<Buffer>, onEntry: (name: string, data: Buffer) => Promise<void>): Promise<void> {
  const extract = tar.extract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: unknown) => chunks.push(c as Buffer));
      stream.on("error", reject);
      stream.on("end", () => {
        onEntry(header.name, Buffer.concat(chunks)).then(() => next(), (e) => {
          reject(e);
          extract.destroy(e instanceof Error ? e : new Error(String(e)));
        });
      });
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  const gunzip = createGunzip();
  const input = Readable.from(source);
  input.on("error", (e) => {
    gunzip.destroy(e);
    extract.destroy(e);
  });
  gunzip.on("error", (e) => extract.destroy(e));
  input.pipe(gunzip).pipe(extract);
  await done;
}
