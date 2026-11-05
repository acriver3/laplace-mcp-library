import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../api/client.js', () => import('./client.js'));
import { createServer } from '../server.js';
import { createTetheredServer } from './server.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
async function connect(server: ReturnType<typeof createServer>) {
  const client = new Client({name:'parity-fixture',version:'1'});
  const [upstream,downstream] = InMemoryTransport.createLinkedPair();
  await server.connect(upstream);
  await client.connect(downstream);
  close.push(async () => {await client.close();await server.close();});
  return client;
}
const relay = () => ({read:vi.fn().mockResolvedValue({value:[]}),pairing:vi.fn(),status:vi.fn(),review:vi.fn(),authorize:vi.fn(),focus:vi.fn(),revoke:vi.fn()});
it('retains every existing Outlook tool and exact input schema', async () => {
  const original = await connect(createServer());
  const tethered = await connect(createTetheredServer(relay()));
  const baseline = (await original.listTools()).tools;
  const actual = (await tethered.listTools()).tools;
  expect(baseline.length).toBeGreaterThan(40);
  for(const tool of baseline) {
    const ported = actual.find(t => t.name === tool.name);
    expect(ported,tool.name).toBeDefined();
    expect(ported!.inputSchema,tool.name).toEqual(tool.inputSchema);
    expect(ported!.annotations,tool.name).toEqual(tool.annotations);
  }
  expect(actual.filter(t => !t.name.startsWith('laplace_browser_')).length).toBe(baseline.length);
});
it('routes existing read formatting through the browser transport', async () => {
  const adapter = relay();
  adapter.read.mockResolvedValue({value:[{Id:'fixture',DisplayName:'Inbox',TotalItemCount:2,UnreadItemCount:1}]});
  const client = await connect(createTetheredServer(adapter));
  const response = await client.callTool({name:'outlook_list_folders',arguments:{}});
  expect(response.isError).not.toBe(true);
  expect(JSON.stringify(response)).toContain('Inbox');
  expect(adapter.read).toHaveBeenCalledWith('owa.get',expect.objectContaining({path:'/mailfolders'}),expect.any(AbortSignal));
});
it('reports interrupted writes without replay', async () => {
  const adapter=relay();
  adapter.read.mockRejectedValue(Error('SAVE_UNVERIFIED: verify before retrying'));
  const client=await connect(createTetheredServer(adapter));
  const result=await client.callTool({name:'outlook_mark_read',arguments:{id:'fixture',is_read:true}});
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('SAVE_UNVERIFIED');
  expect(adapter.read).toHaveBeenCalledTimes(1);
});
