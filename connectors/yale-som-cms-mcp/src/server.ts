import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CmsService } from "./core.js";
import {
  areaSchema,
  changeSchema,
  errorResult,
  readSchema,
  type Area,
  type CmsAdapter,
} from "./types.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const empty = z.object({}).strict();
const query = readSchema.omit({ area: true }).strict();
const detail = query.extend({ id: z.string().min(1).max(200) }).strict();
const readTools: readonly [string, Area, "query" | "detail" | "empty", string][] = [
  [
    "cms_get_dashboard",
    "dashboard",
    "empty",
    "Read announcements, recommendations, and your dashboard calendar.",
  ],
  [
    "cms_search_jobs",
    "jobs",
    "query",
    "Search job postings, with filters and real continuation cursors. Read application methods and deadlines before acting.",
  ],
  [
    "cms_get_job",
    "jobs",
    "detail",
    "Read a job, eligibility, application documents, and native or external application instructions.",
  ],
  [
    "cms_list_applications",
    "applications",
    "query",
    "Read your applications and their authoritative status.",
  ],
  [
    "cms_get_application",
    "applications",
    "detail",
    "Read one of your applications and its current status.",
  ],
  [
    "cms_list_interviews",
    "interviews",
    "query",
    "Read your interviews and available scheduling options.",
  ],
  [
    "cms_get_interview",
    "interviews",
    "detail",
    "Read one interview schedule and exact slot identities.",
  ],
  [
    "cms_search_events",
    "events",
    "query",
    "Search events and registration deadlines, with filters and pagination.",
  ],
  [
    "cms_get_event",
    "events",
    "detail",
    "Read event eligibility, registration state, and exact time slots. Unavailable slots cannot be booked.",
  ],
  [
    "cms_search_appointments",
    "appointments",
    "query",
    "Search coaching and other appointment types and available slots. Use offset timestamps for date bounds.",
  ],
  [
    "cms_get_appointment",
    "appointments",
    "detail",
    "Read an appointment or slot and its current booking state.",
  ],
  [
    "cms_get_calendar",
    "calendar",
    "query",
    "Read your calendar or career-center calendar, with explicit Eastern Time offsets.",
  ],
  [
    "cms_search_employers",
    "employers",
    "query",
    "Search the employer directory, including filters and continuation.",
  ],
  [
    "cms_get_employer",
    "employers",
    "detail",
    "Read employer details, contacts, recruiting activity, jobs, and events.",
  ],
  [
    "cms_search_contacts",
    "contacts",
    "query",
    "Search contacts available to your student account.",
  ],
  [
    "cms_get_contact",
    "contacts",
    "detail",
    "Read one permitted contact and student-editable personal tracking information.",
  ],
  [
    "cms_list_targets",
    "targets",
    "query",
    "Read your target employers or contacts, priorities, and statuses.",
  ],
  ["cms_list_tasks", "tasks", "query", "Read your career tasks, filters, due dates, and status."],
  ["cms_get_task", "tasks", "detail", "Read a specific career task."],
  [
    "cms_get_activity",
    "activity",
    "query",
    "Read recruiting activity with filters and pagination.",
  ],
  [
    "cms_get_profile",
    "profile",
    "query",
    "Read your profile, job preferences, education, and experience. Use form discovery for editable fields.",
  ],
  [
    "cms_list_documents",
    "documents",
    "query",
    "Read application-material metadata and available document categories.",
  ],
  [
    "cms_list_resume_books",
    "resume_books",
    "query",
    "Read resume books, deadlines, and your participation or approval status.",
  ],
  [
    "cms_get_resume_book",
    "resume_books",
    "detail",
    "Read one resume book and its submission requirements.",
  ],
  [
    "cms_search_resources",
    "resources",
    "query",
    "Search resource folders and documents, including continuation.",
  ],
  [
    "cms_get_resource",
    "resources",
    "detail",
    "Read one resource or folder and its permitted download references.",
  ],
  [
    "cms_get_job_analytics",
    "analytics",
    "query",
    "Read Job IQ results with their data source, cohort filters, currency, and any suppressed or unavailable values.",
  ],
  ["cms_list_offices", "offices", "query", "Read school offices available through CMS."],
  ["cms_get_office", "offices", "detail", "Read one school office."],
  [
    "cms_list_saved_searches",
    "saved_searches",
    "query",
    "Read saved searches and alert schedules for the selected view.",
  ],
  [
    "cms_get_settings",
    "settings",
    "query",
    "Read your CMS account settings. External account consent remains interactive.",
  ],
  [
    "cms_list_outcomes",
    "outcomes",
    "query",
    "Read your employment statuses, experiences, and offer reports.",
  ],
  ["cms_get_outcome", "outcomes", "detail", "Read one of your employment or offer reports."],
];

export function createServer(adapter: CmsAdapter, service = new CmsService(adapter)) {
  const server = new McpServer(
    { name: "yale-som-cms-mcp", version: "0.1.0" },
    {
      instructions:
        "Use only student capabilities available to this authenticated Yale SOM CMS account. Discover fields with cms_get_form and show the entire cms_prepare_change preview before requesting confirmation. cms_commit_change requires approval of that exact preview; confirm:true is the caller's attestation, not proof of human consent. Retain MCP client approval controls. Never automatically retry a write. An uncertain or partial result requires inspection and explicit local reconciliation. External application websites and external OAuth consent require handoff. Read cursors and truncation indicators before claiming completeness. Never infer hidden or suppressed research data.",
    },
  );
  function tool(
    name: string,
    description: string,
    schema: z.ZodObject,
    annotations: typeof readAnnotations,
    call: (value: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { description, inputSchema: schema, annotations },
      async (value, extra) => {
        try {
          const result = await call(value, extra.signal);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: { result },
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(errorResult(error)) }],
          };
        }
      },
    );
  }
  tool(
    "cms_session_status",
    "Verify the dedicated CMS browser login and show whether a previous submission needs reconciliation. If signed out, run local login with the same profile and browser.",
    empty,
    readAnnotations,
    (_value, signal) => service.sessionStatus(signal),
  );
  for (const [name, area, shape, description] of readTools) {
    tool(
      name,
      description,
      shape === "empty" ? empty : shape === "detail" ? detail : query,
      readAnnotations,
      (value, signal) => service.read({ ...(value as Record<string, unknown>), area }, signal),
    );
  }
  tool(
    "cms_get_capabilities",
    "Discover student areas and supported operations. Missing permissions or unrecognized workflows are explicitly unavailable; they are never successful empty results.",
    empty,
    readAnnotations,
    (_value, signal) => service.capabilities(signal),
  );
  tool(
    "cms_get_form",
    "Inspect an allowed operation's actual fields, choices, required documents, target state, and eligibility without populating or submitting the form. IDs come from corresponding read tools.",
    changeSchema,
    readAnnotations,
    (value, signal) => service.form(value, signal),
  );
  tool(
    "cms_prepare_change",
    "Prepare one explicitly supported student change WITHOUT remote effects. Supply operation, area, discovered target/slot identifiers, exact field values, and explicit absolute paths for uploads. Show the entire preview, including all compound effects. Drafts expire after ten minutes.",
    changeSchema,
    { ...readAnnotations, idempotentHint: false },
    (value, signal) => service.prepare(value, signal),
  );
  const commitSchema = z.object({ draft_id: z.uuid(), confirm: z.literal(true) }).strict();
  tool(
    "cms_commit_change",
    "Perform the exact preview once, only AFTER the user confirms all its details. Revalidates the account, target state, eligibility, and files. Never replay after failure or uncertainty. Inspect and reconcile partial results locally.",
    commitSchema,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (value, signal) => {
      const input = commitSchema.parse(value);
      return service.commit(input.draft_id, input.confirm, signal);
    },
  );
  tool(
    "cms_download_document",
    "Download a permitted CMS document into the configured downloads folder. Supply a document/resource ID from the corresponding read tool and optionally a plain file name. Existing files are never silently overwritten.",
    z
      .object({
        area: areaSchema,
        id: z.string().min(1).max(200),
        filename: z.string().min(1).max(255).optional(),
      })
      .strict(),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (value, signal) => service.download(value, signal),
  );
  return server;
}
