function recoveryContent(error) {
    const e = error;
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
export function createTetheredServer(relay) {
    const server = new McpServer({ name: 'msoutlook-mcp', version: '0.6.0' });
    setBrowserTransport((method, args, signal) => relay.read(method, args, signal));
    const register = server.tool.bind(server);
    server.tool = ((...values) => {
        const callback = values.pop();
        return Reflect.apply(register, server, [...values, async (args, extra) => {
                try {
                    return await withBrowserInvocation(extra.signal, () => callback(args, extra));
                }
                catch (error) {
                    const recovery = recoveryContent(error);
                    if (!recovery.structuredContent)
                        throw error;
                    return { isError: true, ...recovery, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Browser unavailable.' }] };
                }
            }]);
    });
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
        server.tool('laplace_browser_' + action, 'Internal Laplace browser setup.', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify(await call()) }] }));
    server.tool('laplace_browser_authorize', 'Internal Laplace browser approval.', { candidateId: z.string().uuid(), revision: z.string().uuid() }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(relay.authorize(args)) }] }));
    server.tool('laplace_browser_focus', 'Focus a browser profile after an explicit user request.', { profileId: z.string().uuid() }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(relay.focus(args)) }] }));
    return server;
}
//# sourceMappingURL=server.js.map