function recoveryContent(error: unknown) {
 const e = error as { recovery?: {state?: string; reason?: string}; retryAfterMs?: number };
 return e?.recovery ? { structuredContent: { recovery: e.recovery, retryAfterMs: e.retryAfterMs ?? 0 } } : {};
}
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerMailTools } from '../tools/mail-tools.js';
import { registerCalendarTools } from '../tools/calendar-tools.js';
import { registerContactTools } from '../tools/contact-tools.js';
import { registerDirectoryTools } from '../tools/directory-tools.js';
import { registerTetheredAuthTools } from './auth-tools.js';
import { setBrowserTransport, withBrowserInvocation } from './client.js';

export interface OutlookRelay {
  read(method: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  pairing(): unknown; status(): unknown; review(): unknown;
  authorize(args: unknown): unknown; focus(args: unknown): unknown; revoke(): unknown;
}
export function createTetheredServer(relay: OutlookRelay): McpServer {
  const server = new McpServer({name: 'msoutlook-mcp', version: '0.6.0'});
  setBrowserTransport((method, args, signal) => relay.read(method, args, signal));
  const register = server.tool.bind(server);
  server.tool = ((...values: unknown[]) => {
    const callback = values.pop() as (args: unknown, extra: {signal: AbortSignal}) => unknown;
    return Reflect.apply(register, server, [...values, async (args: unknown, extra: {signal: AbortSignal}) => {
      try { return await withBrowserInvocation(extra.signal, () => callback(args, extra)); }
      catch (error) {
        const recovery = recoveryContent(error);
        if (!recovery.structuredContent) throw error;
        return { isError: true, ...recovery, content: [{type: 'text', text: error instanceof Error ? error.message : 'Browser unavailable.'}] };
      }
    }]);
  }) as typeof server.tool;
  registerTetheredAuthTools(server, () => relay.revoke());
  registerMailTools(server);
  registerCalendarTools(server);
  registerContactTools(server);
  registerDirectoryTools(server);
  const actions = {
    pair: () => relay.pairing(), status: () => relay.status(), review: () => relay.review(),
    revoke: () => relay.revoke(),
  };
  for (const [action, call] of Object.entries(actions))
    server.tool('laplace_browser_' + action, 'Internal Laplace browser setup.', {}, async () => ({content: [{type: 'text', text: JSON.stringify(await call())}]}));
  server.tool('laplace_browser_authorize', 'Internal Laplace browser approval.', {candidateId: z.string().uuid(), revision: z.string().uuid()}, async args => ({content: [{type: 'text', text: JSON.stringify(relay.authorize(args))}]}));
  server.tool('laplace_browser_focus', 'Focus a browser profile after an explicit user request.', {profileId: z.string().uuid()}, async args => ({content: [{type: 'text', text: JSON.stringify(relay.focus(args))}]}));
  return server;
}
