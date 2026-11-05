import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { browserCall } from './client.js';

const result = (value: unknown) => ({content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}]});
export function registerTetheredAuthTools(server: McpServer, revoke: () => unknown): void {
  server.tool('outlook_login',
    'Connect the selected existing Outlook tab through Laplace browser approval. force_new revokes the prior approval; it never clears browser cookies or opens a dedicated browser.',
    { force_new: z.boolean().optional().describe('Force a full re-login even if a session exists — clears the saved session first. Default: false.') },
    async ({force_new}) => {
      if (force_new) { await revoke(); return result({success: false, message: 'Previous approval revoked. Run Laplace browser authentication and approve the intended account.'}); }
      try {
        const status = await browserCall<Record<string, unknown>>('account.status');
        return result({success: true, message: 'Connected to the approved existing Outlook tab.', ...status});
      } catch { return result({success: false, message: 'Run Laplace browser authentication and approve your existing Outlook tab.'}); }
    });
  server.tool('outlook_status', 'Check the approved browser account and session validity.', {}, async () => {
    try { return result(await browserCall('account.status')); }
    catch { return result({authenticated: false, message: 'Open the approved Outlook tab or run Laplace browser authentication.'}); }
  });
  server.tool('outlook_logout', 'Disconnect this connector from its browser account. Does not sign out of Outlook or delete browser session files.', {}, async () => {
    await revoke(); return result({success: true, message: 'Browser approval revoked. Authenticate with Laplace to connect again.'});
  });
}
