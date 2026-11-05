/** Build-time replacement for api/client.ts. No credentials cross this boundary. */
import { AsyncLocalStorage } from 'node:async_hooks';
const invocation = new AsyncLocalStorage<AbortSignal>();
export const withBrowserInvocation = <T>(signal: AbortSignal, work: () => T): T => invocation.run(signal, work);
export type BrowserTransport = (method: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
let transport: BrowserTransport | undefined;
export function setBrowserTransport(value: BrowserTransport) { transport = value; }
export async function browserCall<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!transport) throw Error('Browser transport is unavailable.');
  const result = await transport(method, args, invocation.getStore() ?? AbortSignal.timeout(120000));
  if (result?.error) throw Error(String(result.error));
  return result;
}
export const owaGet = <T>(path: string, params?: Record<string,string>) => browserCall<T>('owa.get', { path, params });
export const owaCloudSettingsGet = <T>(path: string, params?: Record<string,string>, large = false) => browserCall<T>('owa.cloudSettings', { path, params, large });
export const owaPost = <T>(path: string, body: unknown) => browserCall<T>('owa.post', { path, body });
export const owaPatch = <T>(path: string, body: unknown) => browserCall<T>('owa.patch', { path, body });
export async function owaDelete(path: string): Promise<void> { await browserCall('owa.delete', { path }); }
export const graphGetPath = <T>(path: string, params?: Record<string,string>) => browserCall<T>('graph.getPath', { path, params });
export const graphGet = <T>(path: string, params?: Record<string,string>) => graphGetPath<T>('/me' + path, params);
// No maintained tool calls Graph writes; do not grant an unused general Graph proxy.
export async function graphPost<T>(_path: string, _body: unknown): Promise<T> { throw Error('Graph writes are not registered.'); }
export async function graphGetBinary(path: string): Promise<{contentType: string; bytes: Buffer}> {
  const result = await browserCall<{contentType: string; base64: string}>('graph.binary', { path });
  return { contentType: result.contentType, bytes: Buffer.from(result.base64, 'base64') };
}
