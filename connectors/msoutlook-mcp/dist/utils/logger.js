/**
 * Minimal logger that writes to stderr so MCP stdout stays clean.
 */
const isDebug = process.env.MSOUTLOOK_DEBUG === 'true';
export const logger = {
    info: (msg, ...args) => {
        process.stderr.write(`[msoutlook-mcp] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}\n`);
    },
    debug: (msg, ...args) => {
        if (!isDebug)
            return;
        process.stderr.write(`[msoutlook-mcp:debug] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}\n`);
    },
    warn: (msg, ...args) => {
        process.stderr.write(`[msoutlook-mcp:warn] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}\n`);
    },
    error: (msg, ...args) => {
        process.stderr.write(`[msoutlook-mcp:error] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}\n`);
    },
};
//# sourceMappingURL=logger.js.map