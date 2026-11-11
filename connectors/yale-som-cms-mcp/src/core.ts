import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { FileJournal, requiresReconciliation, type JournalRecord } from "./journal.js";
import {
  CmsError,
  TIMEZONE,
  areaSchema,
  changeSchema,
  readSchema,
  type Change,
  type CmsAdapter,
  type Effect,
  type JsonRecord,
  type Prepared,
} from "./types.js";

export const DRAFT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export function fingerprint(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
export interface ServiceOptions {
  profileDir?: string;
  now?: () => number;
  maxUploadBytes?: number;
}
interface FileProof {
  field: string;
  path: string;
  resolved_path: string;
  name: string;
  size: number;
  sha256: string;
}
interface Draft {
  change: Change;
  prepared: Prepared;
  files: FileProof[];
  expires: number;
}
const downloadSchema = z
  .object({
    area: areaSchema.refine(
      (a) => ["documents", "resources", "resume_books", "activity"].includes(a),
      "This area has no document downloads.",
    ),
    id: z.string().min(1).max(200),
    filename: z.string().min(1).max(255).optional(),
  })
  .strict();
function validateChange(value: unknown): Change {
  const change = changeSchema.parse(value);
  const keys = Object.keys(change.fields);
  if (keys.some((k) => ["__proto__", "constructor", "prototype"].includes(k)))
    throw new CmsError("invalid_field", "A reserved field name is not allowed.");
  if (new Set(change.files.map((f) => f.field)).size !== change.files.length)
    throw new CmsError("invalid_file", "Each upload field may be specified only once.");
  if (change.files.some((f) => !isAbsolute(f.path)))
    throw new CmsError("invalid_file", "Uploads require explicit absolute local file paths.");
  return change;
}
async function fileProof(
  field: string,
  path: string,
  maxBytes: number,
  destination?: string,
): Promise<FileProof> {
  const absolute = resolve(path);
  const canonical = await realpath(absolute).catch(() => {
    throw new CmsError("invalid_file", "The selected upload file is unavailable.", {
      field,
      path: absolute,
    });
  });
  const handle = await open(canonical, "r").catch(() => {
    throw new CmsError("invalid_file", "The selected upload file cannot be read.", {
      field,
      path: absolute,
    });
  });
  let target;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes)
      throw new CmsError(
        "invalid_file",
        "Select a nonempty regular file within the upload size limit.",
        { field, path: absolute, max_bytes: maxBytes },
      );
    if (destination) target = await open(destination, "wx", 0o600);
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes)
        throw new CmsError("invalid_file", "The upload exceeds the size limit.", {
          field,
          max_bytes: maxBytes,
        });
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (target) await target.write(bytes);
    }
    const after = await handle.stat();
    if (
      stat.size !== size ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new CmsError(
        "file_changed",
        "The selected file changed while it was being read. Prepare a new preview.",
        { field },
      );
    await target?.sync();
    return {
      field,
      path: absolute,
      resolved_path: canonical,
      name: basename(canonical),
      size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
    await target?.close();
  }
}
export class CmsService {
  readonly queue = new SerialQueue();
  private readonly drafts = new Map<string, Draft>();
  private readonly journal?: FileJournal;
  private readonly now: () => number;
  private readonly maxUploadBytes: number;
  private unresolvedInMemory = false;
  constructor(
    readonly adapter: CmsAdapter,
    readonly options: ServiceOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (!Number.isSafeInteger(this.maxUploadBytes) || this.maxUploadBytes < 1)
      throw new CmsError("invalid_configuration", "maxUploadBytes must be a positive integer.");
    if (options.profileDir) this.journal = new FileJournal(options.profileDir);
  }
  private run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queue.run(async () => {
      if (signal?.aborted)
        throw new CmsError("cancelled", "The tool call was cancelled before execution.");
      let closing: Promise<void> | undefined;
      const abort = () => {
        closing = this.adapter.close().catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await work();
      } finally {
        signal?.removeEventListener("abort", abort);
        await closing;
      }
    });
  }
  private requireJournal(): FileJournal {
    if (!this.journal)
      throw new CmsError(
        "journal_unconfigured",
        "Start the connector with its dedicated profile directory before preparing changes.",
      );
    return this.journal;
  }
  private async writable() {
    const journal = this.requireJournal();
    const record = await journal.read();
    if (this.unresolvedInMemory || requiresReconciliation(record))
      throw new CmsError(
        "reconciliation_required",
        "A prior submission needs inspection in CMS. Use local status and explicitly acknowledge the verified outcome before another change.",
        {
          operation_id: record?.operation_id,
          operation: record?.operation,
          status: record?.status || "uncertain",
        },
      );
    return journal;
  }
  async sessionStatus(signal?: AbortSignal) {
    return this.run(async () => {
      const identity = await this.adapter.identity();
      return {
        authenticated: true,
        account: identity.name,
        ...(identity.account_id ? { account_id: identity.account_id } : {}),
        timezone: TIMEZONE,
        recovery: await this.recovery(),
      };
    }, signal);
  }
  async read(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const input = readSchema.parse(value);
      if (input.start && input.end && Date.parse(input.end) < Date.parse(input.start))
        throw new CmsError("invalid_time", "end must follow start.");
      return this.adapter.read(input);
    }, signal);
  }
  async form(value: unknown, signal?: AbortSignal) {
    return this.run(() => this.adapter.form(validateChange(value)), signal);
  }
  async capabilities(signal?: AbortSignal) {
    return this.run(() => this.adapter.capabilities(), signal);
  }
  async download(value: unknown, signal?: AbortSignal) {
    return this.run(() => {
      const input = downloadSchema.parse(value);
      if (
        input.filename &&
        (basename(input.filename) !== input.filename ||
          input.filename === "." ||
          input.filename === ".." ||
          /[\\/\0]/.test(input.filename))
      )
        throw new CmsError(
          "invalid_filename",
          "Use a plain file name within the configured downloads folder.",
        );
      return this.adapter.download(input);
    }, signal);
  }
  async prepare(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      await this.writable();
      const change = validateChange(value);
      const files: FileProof[] = [];
      for (const file of change.files)
        files.push(await fileProof(file.field, file.path, this.maxUploadBytes));
      const prepared = await this.adapter.prepare(change);
      if (!prepared.identity || !prepared.preview || typeof prepared.preview !== "object")
        throw new CmsError("invalid_preview", "CMS did not expose an account-bound preview.");
      // The core owns the exact change and file proofs even if a module omits a field.
      const preview = {
        ...prepared.preview,
        operation: change.operation,
        area: change.area,
        target_id: change.target_id,
        parent_id: change.parent_id,
        slot_id: change.slot_id,
        requested_fields: structuredClone(change.fields),
        files,
      };
      for (const [id, draft] of this.drafts)
        if (draft.expires <= this.now()) this.drafts.delete(id);
      if (this.drafts.size >= 50)
        throw new CmsError(
          "too_many_drafts",
          "Finish or let existing previews expire before preparing more changes.",
        );
      const draft_id = randomUUID(),
        expires = this.now() + DRAFT_TTL_MS;
      this.drafts.set(draft_id, {
        change: structuredClone(change),
        prepared: structuredClone(prepared),
        files: structuredClone(files),
        expires,
      });
      return {
        draft_id,
        expires_at: new Date(expires).toISOString(),
        preview,
        instructions:
          "Show the complete preview and obtain confirmation for these exact changes before cms_commit_change. No remote changes have been made.",
      };
    }, signal);
  }
  async commit(id: string, confirm: boolean, signal?: AbortSignal) {
    return this.run(async () => {
      if (confirm !== true)
        throw new CmsError(
          "confirmation_required",
          "The user must confirm the full preview before submission.",
        );
      const draft = this.drafts.get(id);
      this.drafts.delete(id);
      if (!draft || draft.expires <= this.now())
        throw new CmsError(
          "draft_expired",
          "Prepare and confirm a fresh preview. This draft cannot be replayed.",
        );
      const journal = await this.writable();
      const current = await this.adapter.prepare(draft.change);
      if (current.identity !== draft.prepared.identity)
        throw new CmsError(
          "account_changed",
          "The CMS account or session changed. Prepare a new preview.",
        );
      if (fingerprint(current.preview) !== fingerprint(draft.prepared.preview))
        throw new CmsError(
          "preview_changed",
          "The target, eligibility, form, or existing state changed. Prepare a new preview.",
        );
      if (draft.expires <= this.now())
        throw new CmsError(
          "draft_expired",
          "The draft expired during revalidation. Prepare a new preview.",
        );
      let staging: string | undefined;
      try {
        const change = structuredClone(draft.change);
        if (change.files.length) {
          const stagingRoot = join(dirname(journal.file), "cms-upload-staging");
          await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
          staging = await mkdtemp(join(stagingRoot, "confirmed-"));
          for (let i = 0; i < change.files.length; i++) {
            const dir = join(staging, String(i));
            await mkdir(dir, { mode: 0o700 });
            const destination = join(dir, draft.files[i].name);
            const proof = await fileProof(
              change.files[i].field,
              change.files[i].path,
              this.maxUploadBytes,
              destination,
            );
            if (fingerprint(proof) !== fingerprint(draft.files[i]))
              throw new CmsError(
                "file_changed",
                "An approved upload file changed. Prepare a new preview.",
                { field: proof.field },
              );
            await chmod(destination, 0o400);
            change.files[i].path = destination;
          }
        }
        if (signal?.aborted)
          throw new CmsError("cancelled", "The submission was cancelled before any remote change.");
        if (draft.expires <= this.now())
          throw new CmsError(
            "draft_expired",
            "The draft expired while preparing uploads. Prepare a new preview.",
          );
        let record: JournalRecord = {
          version: 1,
          operation_id: randomUUID(),
          operation: change.operation,
          area: change.area,
          ...(change.target_id ? { target_id: change.target_id } : {}),
          account_fingerprint: fingerprint(current.identity),
          preview_fingerprint: fingerprint({ preview: current.preview, files: draft.files }),
          started_at: new Date(this.now()).toISOString(),
          updated_at: new Date(this.now()).toISOString(),
          status: "pending",
          effects: [
            {
              name: change.operation,
              status: "intended",
              ...(change.target_id ? { target: change.target_id } : {}),
            },
          ],
        };
        await journal.write(record);
        this.unresolvedInMemory = true;
        const recordEffect = async (effect: Effect) => {
          if (signal?.aborted)
            throw new CmsError(
              "cancelled",
              "The submission was interrupted; reconcile its outcome before another change.",
            );
          const safe = FileJournal.effect(effect);
          record = {
            ...record,
            updated_at: new Date(this.now()).toISOString(),
            effects: [...record.effects, safe],
          };
          await journal.write(record);
        };
        try {
          const result = await this.adapter.submit(change, recordEffect);
          if (!["verified", "pending", "partial", "uncertain"].includes(result.status))
            throw new CmsError(
              "verification_failed",
              "CMS returned no recognizable submission outcome.",
            );
          const effects = result.effects.map(FileJournal.effect);
          const verifiedEffects =
            effects.length > 0 && effects.every((e) => e.status === "verified");
          const blocked =
            result.status === "partial" || result.status === "uncertain" || !verifiedEffects;
          record = {
            ...record,
            status: blocked ? (result.status === "partial" ? "partial" : "uncertain") : "complete",
            updated_at: new Date(this.now()).toISOString(),
            effects: [...record.effects, ...effects].slice(-100),
          };
          await journal.write(record);
          if (blocked) {
            throw new CmsError(
              result.status === "partial" ? "submission_partial" : "submission_uncertain",
              "Some or all steps may have reached CMS. Inspect the authoritative record and reconcile locally; do not replay this draft.",
              { operation_id: record.operation_id, result },
            );
          }
          this.unresolvedInMemory = false;
          return { ...result, operation_id: record.operation_id };
        } catch (error) {
          if (record.status !== "partial") {
            record = {
              ...record,
              status: "uncertain",
              updated_at: new Date(this.now()).toISOString(),
            };
            await journal.write(record).catch(() => {});
          }
          if (
            error instanceof CmsError &&
            ["submission_partial", "submission_uncertain"].includes(error.code)
          )
            throw error;
          throw new CmsError(
            "submission_uncertain",
            "The change may have reached CMS. The draft has been consumed. Inspect the result and reconcile locally before another change.",
            {
              operation_id: record.operation_id,
              operation: change.operation,
              effects: record.effects,
            },
          );
        }
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    }, signal);
  }
  private async recovery(): Promise<JsonRecord> {
    if (!this.journal) return { configured: false, blocked: this.unresolvedInMemory };
    const record = await this.journal.read();
    return {
      configured: true,
      blocked: this.unresolvedInMemory || requiresReconciliation(record),
      ...(record
        ? {
            operation_id: record.operation_id,
            operation: record.operation,
            status: record.status,
            effects: record.effects,
            updated_at: record.updated_at,
          }
        : {}),
    };
  }
  async recoveryStatus() {
    return this.run(() => this.recovery());
  }
  /** CLI-only: caller must hold the dedicated browser profile lock and inspect CMS first. */
  async acknowledgeUncertain(input: { acknowledge: true; note: string }) {
    return this.run(async () => {
      if (input.acknowledge !== true || input.note.trim().length < 10 || input.note.length > 2000)
        throw new CmsError(
          "acknowledgement_required",
          "Explicitly acknowledge the inspected outcome with a descriptive local note.",
        );
      const journal = this.requireJournal(),
        record = await journal.read();
      if (!record) {
        if (this.unresolvedInMemory)
          throw new CmsError(
            "journal_invalid",
            "No persisted receipt exists for the uncertain operation. Inspect local state before recovery.",
          );
        return { acknowledged: false, reason: "No submission needs reconciliation." };
      }
      if (!requiresReconciliation(record)) {
        this.unresolvedInMemory = false;
        return { acknowledged: false, reason: "The latest submission is already resolved." };
      }
      await journal.write({
        ...record,
        status: "acknowledged",
        updated_at: new Date(this.now()).toISOString(),
        acknowledgement: input.note.trim(),
      });
      this.unresolvedInMemory = false;
      this.drafts.clear();
      return { acknowledged: true, operation_id: record.operation_id, replayed: false };
    });
  }
  async close() {
    return this.queue.run(async () => {
      this.drafts.clear();
      await this.adapter.close();
    });
  }
}
