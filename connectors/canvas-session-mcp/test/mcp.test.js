import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

// Starts the real server over stdio, like Claude Desktop would, without any Canvas login.
test('MCP server marks read and write tools and reports a missing login as a tool error', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-empty-'));
  const env = { ...process.env, CANVAS_MCP_HOME: home };
  delete env.CANVAS_URL;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env }));
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 15);
    const writes = ['canvas_submit_assignment', 'canvas_comment_on_submission', 'canvas_post_discussion_reply', 'canvas_send_message', 'canvas_join_group', 'canvas_leave_group', 'canvas_planner_mark_done', 'canvas_create_planner_note', 'canvas_delete_planner_note'];
    assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort(), [...writes].sort());
    assert.equal(tools.find((t) => t.name === 'canvas_submit_assignment').annotations.destructiveHint, true);
    // Anything graded or seen by others cannot be called without an explicit confirm:true.
    for (const name of writes.slice(0, 6)) assert.ok(tools.find((t) => t.name === name).inputSchema.required.includes('confirm'), name);
    assert.ok(tools.find((t) => t.name === 'canvas_read_file').inputSchema.required.includes('file_id'));
    const r = await client.callTool({ name: 'canvas_whoami', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /main.tar.gz setup/);   // a command people can paste as is
  } finally {
    await client.close();
  }
});
