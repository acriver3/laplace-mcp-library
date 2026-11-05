import { TokenRefreshError } from './auth/token-refresh.js';
/**
 * MCP server setup — registers all tools and starts the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAuthTools } from './tools/auth-tools.js';
import { registerMailTools } from './tools/mail-tools.js';
import { registerCalendarTools } from './tools/calendar-tools.js';
import { registerContactTools } from './tools/contact-tools.js';
import { registerDirectoryTools } from './tools/directory-tools.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'msoutlook-mcp',
    version: '0.3.0',
  });

  const register = server.tool.bind(server);
  server.tool = ((...values: unknown[]) => {
    const callback = values.pop() as (...args: unknown[]) => unknown;
    return Reflect.apply(register, server, [...values, async (...args: unknown[]) => {
      try { return await callback(...args); }
      catch (error) {
        if (!(error instanceof TokenRefreshError)) throw error;
        return { isError: true,
          structuredContent: { recovery: {state: error.code === 'invalid_grant' ? 'sign_in_required' : error.code === 'refresh_failed' ? 'unavailable' : 'reconnecting', reason: error.code === 'invalid_grant' ? 'session_expired' : error.code === 'refresh_failed' ? 'verification_failed' : error.code}, retryAfterMs:error.retryAfterMs },
          content:[{type:'text', text:error.message}] };
      }
    }]);
  }) as typeof server.tool;
  registerAuthTools(server);
  registerMailTools(server);
  registerCalendarTools(server);
  registerContactTools(server);
  registerDirectoryTools(server);

  return server;
}
