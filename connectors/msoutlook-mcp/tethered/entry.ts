import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OutlookBrowserRelay } from '../../../browser-runtime/src/outlook-browser-relay';
import { createTetheredServer } from '../src/tethered/server';

async function main() {
  if (process.env.LAPLACE_TETHERED_BROWSER_V1 !== 'true') throw Error('Tethered Outlook is not activated.');
  const relay = new OutlookBrowserRelay();
  await relay.listen();
  const server = createTetheredServer(relay);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await relay.close();
    await server.close();
  };
  process.stdin.once('end', () => void close());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  await server.connect(new StdioServerTransport());
}
main().catch(() => { process.stderr.write('Tethered Outlook could not start. Check activation and the browser runtime.\n'); process.exitCode = 1; });
