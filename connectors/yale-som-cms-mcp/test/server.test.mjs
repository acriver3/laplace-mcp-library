import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CmsService } from "../dist/core.js";
import { createServer } from "../dist/server.js";

function fixtureAdapter() {
  return {
    async identity() {
      return { key: "private-session-secret", name: "Fixture Student", account_id: "student-1" };
    },
    async read(input) {
      return {
        area: input.area,
        url: "https://som-yale.12twenty.com/dashboard/",
        title: "Fixture",
        timezone: "America/New_York",
        text: "Fixture data",
        records: [],
        request: input,
      };
    },
    async form(input) {
      return {
        operation: input.operation,
        area: input.area,
        supported: true,
        url: "https://som-yale.12twenty.com/tasks/",
        fields: [{ id: "subject", label: "Subject", type: "text", required: true }],
        actions: ["Save"],
        context: {},
      };
    },
    async capabilities() {
      return { areas: ["dashboard", "tasks"] };
    },
    async prepare(input) {
      return {
        identity: "private-session-secret",
        preview: { account: "Fixture Student", operation: input.operation, fields: input.fields },
      };
    },
    async submit(input, recordEffect) {
      await recordEffect({ name: input.operation, status: "intended" });
      return {
        status: "verified",
        url: "https://som-yale.12twenty.com/tasks/",
        effects: [{ name: input.operation, status: "verified" }],
        result: { id: "new-task" },
      };
    },
    async download(input) {
      return {
        filename: input.filename,
        path: "/fixtures/downloads/" + (input.filename || "document.pdf"),
      };
    },
    async close() {},
  };
}
async function connected(t) {
  const dir = await mkdtemp(join(tmpdir(), "cms-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = fixtureAdapter(),
    service = new CmsService(adapter, { profileDir: join(dir, "profile") });
  const server = createServer(adapter, service),
    client = new Client({ name: "cms-fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  t.after(async () => {
    await client.close();
    await server.close();
    await service.close();
  });
  return { client, server, adapter, service, dir };
}
test("MCP tool discovery covers every student area with explicit mutation boundaries", async (t) => {
  const { client } = await connected(t),
    { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const name of [
    "cms_session_status",
    "cms_get_dashboard",
    "cms_search_jobs",
    "cms_list_applications",
    "cms_list_interviews",
    "cms_search_events",
    "cms_search_appointments",
    "cms_get_calendar",
    "cms_search_employers",
    "cms_search_contacts",
    "cms_list_targets",
    "cms_list_tasks",
    "cms_get_activity",
    "cms_get_profile",
    "cms_list_documents",
    "cms_list_resume_books",
    "cms_search_resources",
    "cms_get_job_analytics",
    "cms_list_offices",
    "cms_list_saved_searches",
    "cms_get_settings",
    "cms_list_outcomes",
    "cms_get_capabilities",
    "cms_get_form",
    "cms_prepare_change",
    "cms_commit_change",
    "cms_download_document",
  ])
    assert.ok(names.has(name), name);
  assert.equal(tools.find((t) => t.name === "cms_commit_change").annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "cms_commit_change").annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "cms_prepare_change").annotations.readOnlyHint, true);
  assert.equal(
    tools.find((t) => t.name === "cms_prepare_change").annotations.idempotentHint,
    false,
  );
  assert.equal(
    tools.find((t) => t.name === "cms_download_document").annotations.destructiveHint,
    false,
  );
  assert.equal(
    tools.find((t) => t.name === "cms_download_document").annotations.readOnlyHint,
    false,
  );
  for (const name of ["cms_session_status", "cms_get_dashboard"])
    assert.deepEqual(tools.find((t) => t.name === name).inputSchema.properties, {});
  assert.ok(tools.every((t) => t.inputSchema.type === "object"));
  assert.ok(tools.every((t) => t.inputSchema.additionalProperties === false));
});
test("setup checks expose account and dashboard data without session material", async (t) => {
  const { client } = await connected(t);
  const status = await client.callTool({ name: "cms_session_status", arguments: {} });
  assert.equal(status.structuredContent.result.account, "Fixture Student");
  assert.equal(status.structuredContent.result.authenticated, true);
  assert.equal(JSON.stringify(status).includes("private-session-secret"), false);
  const dashboard = await client.callTool({ name: "cms_get_dashboard", arguments: {} });
  assert.equal(dashboard.structuredContent.result.area, "dashboard");
  assert.equal(dashboard.structuredContent.result.timezone, "America/New_York");
});
test("domain read tools preserve filters, continuation and exact IDs", async (t) => {
  const { client } = await connected(t);
  const r = await client.callTool({
    name: "cms_search_jobs",
    arguments: {
      query: "Strategy",
      filters: { industry: ["Technology"], saved: true },
      cursor: "page-2",
      limit: 5,
    },
  });
  assert.deepEqual(r.structuredContent.result.request, {
    area: "jobs",
    query: "Strategy",
    filters: { industry: ["Technology"], saved: true },
    cursor: "page-2",
    limit: 5,
  });
  const detail = await client.callTool({
    name: "cms_get_job",
    arguments: { id: "35006705587971" },
  });
  assert.equal(detail.structuredContent.result.request.id, "35006705587971");
  assert.equal(detail.structuredContent.result.request.area, "jobs");
});
test("unknown operations, cross-area overrides and extra commit arguments are rejected", async (t) => {
  const { client, adapter } = await connected(t);
  let submits = 0;
  adapter.submit = async () => {
    submits++;
    throw new Error("must not run");
  };
  for (const call of [
    { name: "cms_search_jobs", arguments: { area: "settings" } },
    { name: "cms_get_job", arguments: {} },
    {
      name: "cms_get_form",
      arguments: { operation: "evaluate_javascript", area: "profile", code: "alert(1)" },
    },
    {
      name: "cms_prepare_change",
      arguments: { operation: "request", area: "profile", url: "https://other.example" },
    },
    { name: "cms_commit_change", arguments: { draft_id: "not-a-uuid", confirm: true } },
    {
      name: "cms_commit_change",
      arguments: {
        draft_id: "2ea0c1ae-d859-49f2-80be-74ef43c8dc26",
        confirm: true,
        fields: { changed: true },
      },
    },
  ]) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true, call.name);
  }
  assert.equal(submits, 0);
});
test("MCP performs exact confirmed previews once and returns structured errors on replay", async (t) => {
  const { client } = await connected(t);
  const p = await client.callTool({
    name: "cms_prepare_change",
    arguments: { operation: "task_create", area: "tasks", fields: { subject: "Review jobs" } },
  });
  assert.equal(p.isError, undefined);
  assert.equal(JSON.stringify(p).includes("private-session-secret"), false);
  const draft_id = p.structuredContent.result.draft_id;
  const bad = await client.callTool({
    name: "cms_commit_change",
    arguments: { draft_id, confirm: false },
  });
  assert.equal(bad.isError, true);
  const committed = await client.callTool({
    name: "cms_commit_change",
    arguments: { draft_id, confirm: true },
  });
  assert.equal(committed.structuredContent.result.status, "verified");
  const repeated = await client.callTool({
    name: "cms_commit_change",
    arguments: { draft_id, confirm: true },
  });
  assert.equal(repeated.isError, true);
  assert.equal(JSON.parse(repeated.content[0].text).code, "draft_expired");
});
test("real stdio initializes and discovers tools without starting Chrome or authenticating", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cms-stdio-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "stdio-fixture.mjs");
  const serverUrl = pathToFileURL(resolve("dist/server.js")).href;
  const transportUrl = pathToFileURL(
    resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"),
  ).href;
  await writeFile(
    file,
    `import {createServer} from ${JSON.stringify(serverUrl)};
import {StdioServerTransport} from ${JSON.stringify(transportUrl)};
const adapter={async identity(){throw new Error("auth_required")},async close(){}};
const server=createServer(adapter);
await server.connect(new StdioServerTransport());
`,
  );
  const client = new Client({ name: "stdio-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [file],
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "cms_get_dashboard"));
  assert.ok(tools.some((t) => t.name === "cms_commit_change"));
  const status = await client.callTool({ name: "cms_session_status", arguments: {} });
  assert.equal(status.isError, true);
});
