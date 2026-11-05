/** Build-time replacement for api/client.ts. No credentials cross this boundary. */
import { AsyncLocalStorage } from 'node:async_hooks';
const invocation = new AsyncLocalStorage();
export const withBrowserInvocation = (signal, work) => invocation.run({ signal }, async () => {
    const result = await work();
    const failure = invocation.getStore()?.failure;
    if (failure)
        throw failure;
    return result;
});
let transport;
export function setBrowserTransport(value) { transport = value; }
export async function browserCall(method, args = {}) {
    if (!transport)
        throw Error('Browser transport is unavailable.');
    let result;
    try {
        result = await transport(method, args, invocation.getStore()?.signal ?? AbortSignal.timeout(120000));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'recovery' in error && invocation.getStore())
            invocation.getStore().failure = error;
        throw error;
    }
    if (result?.error)
        throw Error(String(result.error));
    return result;
}
export const owaGet = (path, params) => browserCall('owa.get', { path, params });
export const owaCloudSettingsGet = (path, params, large = false) => browserCall('owa.cloudSettings', { path, params, large });
export const owaPost = (path, body) => browserCall('owa.post', { path, body });
export const owaPatch = (path, body) => browserCall('owa.patch', { path, body });
export async function owaDelete(path) { await browserCall('owa.delete', { path }); }
export const graphGetPath = (path, params) => browserCall('graph.getPath', { path, params });
export const graphGet = (path, params) => graphGetPath('/me' + path, params);
// No maintained tool calls Graph writes; do not grant an unused general Graph proxy.
export async function graphPost(_path, _body) { throw Error('Graph writes are not registered.'); }
export async function graphGetBinary(path) {
    const result = await browserCall('graph.binary', { path });
    return { contentType: result.contentType, bytes: Buffer.from(result.base64, 'base64') };
}
//# sourceMappingURL=client.js.map