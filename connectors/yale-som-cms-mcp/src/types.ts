import { z } from "zod";

export const CMS_ORIGIN = "https://som-yale.12twenty.com";
export const DASHBOARD = CMS_ORIGIN + "/dashboard/";
export const TIMEZONE = "America/New_York";
export const areas = [
  "dashboard",
  "jobs",
  "applications",
  "interviews",
  "events",
  "appointments",
  "calendar",
  "employers",
  "contacts",
  "targets",
  "tasks",
  "activity",
  "profile",
  "documents",
  "resume_books",
  "resources",
  "analytics",
  "offices",
  "saved_searches",
  "settings",
  "outcomes",
] as const;
export const areaSchema = z.enum(areas);
export type Area = z.infer<typeof areaSchema>;
export const valueSchema = z.union([
  z.string().max(20000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(2000)).max(100),
]);
export type FieldValue = z.infer<typeof valueSchema>;
export const readSchema = z
  .object({
    area: areaSchema,
    id: z.string().min(1).max(200).optional(),
    query: z.string().max(500).optional(),
    filters: z.record(z.string().max(200), valueSchema).optional(),
    cursor: z.string().max(4000).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    start: z.iso.datetime({ offset: true }).optional(),
    end: z.iso.datetime({ offset: true }).optional(),
    view: z.string().max(100).optional(),
  })
  .strict();
export type ReadRequest = z.infer<typeof readSchema>;
export const operations = [
  "favorite_set",
  "target_add",
  "target_update",
  "target_remove",
  "task_create",
  "task_update",
  "task_complete",
  "task_delete",
  "saved_search_create",
  "saved_search_update",
  "saved_search_delete",
  "event_register",
  "event_cancel",
  "appointment_book",
  "appointment_cancel",
  "interview_book",
  "interview_cancel",
  "application_submit",
  "application_withdraw",
  "document_upload",
  "document_update",
  "document_delete",
  "resume_book_submit",
  "resume_book_withdraw",
  "profile_update",
  "profile_image_update",
  "education_create",
  "education_update",
  "education_delete",
  "experience_create",
  "experience_update",
  "experience_delete",
  "outcome_create",
  "outcome_update",
  "outcome_delete",
  "contact_create",
  "contact_update",
  "contact_delete",
  "activity_create",
  "activity_update",
  "activity_delete",
  "settings_update",
] as const;
export const changeSchema = z
  .object({
    operation: z.enum(operations),
    area: areaSchema,
    target_id: z.string().min(1).max(200).optional(),
    parent_id: z.string().min(1).max(200).optional(),
    slot_id: z.string().min(1).max(200).optional(),
    fields: z.record(z.string().min(1).max(200), valueSchema).default({}),
    files: z
      .array(
        z
          .object({
            field: z.string().min(1).max(200),
            path: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();
export type Change = z.infer<typeof changeSchema>;
export type Operation = Change["operation"];
export type JsonRecord = Record<string, unknown>;
export interface Identity {
  key: string;
  name: string;
  account_id?: string;
}
export interface FormField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  value?: FieldValue;
  options?: { value: string; label: string; disabled?: boolean }[];
  read_only?: boolean;
}
export interface CmsRecord {
  id: string;
  name: string;
  url?: string;
  [key: string]: unknown;
}
export interface ReadResult {
  area: Area;
  url: string;
  title: string;
  timezone: string;
  text: string;
  records: CmsRecord[];
  fields?: FormField[];
  next_cursor?: string;
  truncated?: boolean;
  [key: string]: unknown;
}
export interface FormResult {
  operation: Operation;
  area: Area;
  target_id?: string;
  supported: boolean;
  reason?: string;
  url: string;
  fields: FormField[];
  actions: string[];
  context: JsonRecord;
}
export interface Prepared {
  identity: string;
  preview: JsonRecord;
}
export interface Effect {
  name: string;
  status: "intended" | "verified" | "uncertain";
  target?: string;
  details?: JsonRecord;
}
export interface MutationResult {
  status: "verified" | "pending" | "partial" | "uncertain";
  url: string;
  effects: Effect[];
  result?: JsonRecord;
}
export type RecordEffect = (effect: Effect) => Promise<void>;
export interface CmsAdapter {
  identity(): Promise<Identity>;
  read(input: ReadRequest): Promise<ReadResult>;
  form(change: Change): Promise<FormResult>;
  capabilities(): Promise<JsonRecord>;
  prepare(change: Change): Promise<Prepared>;
  submit(change: Change, recordEffect: RecordEffect): Promise<MutationResult>;
  download(input: {
    area: Area;
    id: string;
    filename?: string;
  }): Promise<JsonRecord>;
  close(): Promise<void>;
}
export class CmsError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CmsError";
  }
}
export function errorResult(error: unknown) {
  if (error instanceof CmsError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  if (error instanceof z.ZodError)
    return {
      code: "invalid_input",
      message: "Input did not match this CMS tool.",
      details: error.issues,
    };
  return {
    code: "cms_error",
    message: error instanceof Error ? error.message : "CMS operation failed.",
  };
}
