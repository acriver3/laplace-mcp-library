import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { CmsError, type Effect } from "./types.js";

const effectSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: z.enum(["intended", "verified", "uncertain"]),
    target: z.string().max(1000).optional(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    operation_id: z.uuid(),
    operation: z.string().min(1).max(100),
    area: z.string().min(1).max(100),
    target_id: z.string().max(200).optional(),
    account_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    preview_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    started_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    status: z.enum(["pending", "uncertain", "partial", "complete", "acknowledged"]),
    effects: z.array(effectSchema).max(100),
    acknowledgement: z.string().max(2000).optional(),
  })
  .strict();
export type JournalRecord = z.infer<typeof journalSchema>;
export function requiresReconciliation(record: JournalRecord | null) {
  return !!record && ["pending", "uncertain", "partial"].includes(record.status);
}
/** Durable, minimal receipt. Answers, cookies and document bytes are never journaled. */
export class FileJournal {
  readonly file: string;
  constructor(profileDir: string) {
    if (!isAbsolute(profileDir))
      throw new CmsError(
        "invalid_profile",
        "The journal requires an absolute dedicated profile directory.",
      );
    this.file = resolve(profileDir) + ".cms-journal.json";
  }
  async read(): Promise<JournalRecord | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CmsError("journal_unavailable", "Could not read the local submission journal.");
    }
    try {
      return journalSchema.parse(JSON.parse(text));
    } catch {
      throw new CmsError(
        "journal_invalid",
        "The local submission journal is invalid. Inspect it locally before making changes; it has not been deleted.",
      );
    }
  }
  async write(record: JournalRecord) {
    const data = journalSchema.parse(record);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.file);
      // Flush the rename on filesystems supporting directory fsync.
      let directory;
      try {
        directory = await open(dirname(this.file), "r");
        await directory.sync();
      } catch (error) {
        if (
          !["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES", "EBADF"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
      } finally {
        await directory?.close();
      }
    } catch {
      throw new CmsError(
        "journal_unavailable",
        "Could not persist submission state. No further remote step may run until the journal is writable and the outcome is reconciled.",
      );
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  static effect(effect: Effect) {
    // Deliberately omit arbitrary details, which could contain personal answers.
    return effectSchema.parse({
      name: effect.name,
      status: effect.status,
      ...(effect.target ? { target: effect.target } : {}),
    });
  }
}
