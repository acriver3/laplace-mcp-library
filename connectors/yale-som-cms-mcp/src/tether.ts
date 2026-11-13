import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { chromium, type Browser, type Page } from "playwright-core";
import WebSocket, { WebSocketServer } from "ws";

import { CMS_ORIGIN, CmsError } from "./types.js";

export const DEFAULT_CDP_URL = "ws://127.0.0.1:9222/devtools/browser";
export function validateCdpUrl(endpoint: string): string {
  const match =
    /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(\/devtools\/browser(?:\/[A-Za-z0-9_-]+)?)$/.exec(
      endpoint,
    );
  if (!match || /\s/.test(endpoint) || Number(match[2]) > 65535)
    throw new CmsError(
      "invalid_cdp_url",
      "Use an existing Chrome browser WebSocket at ws://127.0.0.1:9222/devtools/browser (or another explicit loopback endpoint). Credentials, query strings, fragments and remote hosts are not allowed.",
    );
  return endpoint; // Preserve explicit :80; URL serialization would remove it.
}
type Message = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  sessionId?: string;
  result?: any;
  error?: { code: number; message: string };
};
type TargetInfo = {
  targetId: string;
  type: string;
  url: string;
  title: string;
  browserContextId?: string;
  [key: string]: any;
};
type Session = { targetId: string; type: string; parent?: string; origin?: string };
const ROOT_READS = new Set(["Browser.getVersion"]);
const PAGE_METHODS = new Set([
  "Page.enable",
  "Page.disable",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Page.setFontFamilies",
  "Page.createIsolatedWorld",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.navigate",
  "Page.reload",
  "Page.stopLoading",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.bringToFront",
  "Page.setInterceptFileChooserDialog",
  "Page.close",
  "Runtime.enable",
  "Runtime.disable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.addBinding",
  "Runtime.removeBinding",
  "DOM.enable",
  "DOM.disable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.setFileInputFiles",
  "DOM.getFileInfo",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "CSS.enable",
  "CSS.disable",
  "CSS.getComputedStyleForNode",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.dispatchTouchEvent",
  "Input.synthesizeScrollGesture",
  "Log.enable",
  "Log.disable",
  "Network.enable",
  "Network.disable",
  "Network.setCacheDisabled",
  "Network.getResponseBody",
  "Network.getRequestPostData",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "Fetch.getResponseBody",
  "Fetch.continueWithAuth",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setEmulatedMedia",
]);
const cmsHost = new URL(CMS_ORIGIN).hostname;
function cmsCookies(cookies: any[]): any[] {
  return cookies.filter((cookie) => {
    const domain = String(cookie.domain || "")
      .replace(/^\./, "")
      .toLowerCase();
    return domain === cmsHost || domain === "12twenty.com";
  });
}

/** A single-client loopback CDP gateway exposing only its own newly created tab.
 * It never sends browser-wide auto-attach, discovery, downloads, storage writes,
 * permissions, browser close, or context disposal to the user's Chrome.
 */
export class OwnedTargetGateway {
  private upstream?: WebSocket;
  private server?: WebSocketServer;
  private client?: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sessions = new Map<string, Session>();
  private initializing = new Map<string, Message[]>();
  private blockedTransports = new Set<string>();
  private target?: TargetInfo;
  private mainSession?: string;
  private mainReady?: Promise<void>;
  private resolveMain?: () => void;
  private closing?: Promise<void>;
  private disconnected = false;
  private endpoint?: string;
  private constructor(
    readonly cdpUrl: string,
    private readonly guardTransports = true,
  ) {}
  static async open(endpoint: string, guardTransports = true): Promise<OwnedTargetGateway> {
    const gateway = new OwnedTargetGateway(validateCdpUrl(endpoint), guardTransports);
    try {
      await gateway.start();
      return gateway;
    } catch (error) {
      await gateway.close();
      throw error;
    }
  }
  get endpointURL(): string {
    if (!this.endpoint)
      throw new CmsError("browser_unavailable", "The private Chrome connection is not ready.");
    return this.endpoint;
  }
  get targetId(): string | undefined {
    return this.target?.targetId;
  }
  unsupportedTransports(): string[] {
    return [...this.blockedTransports];
  }
  private async guardWorker(sessionId: string) {
    await this.rpc("Runtime.enable", {}, sessionId);
    await this.rpc("Runtime.addBinding", { name: "__cmsWorkerTransportBlocked" }, sessionId);
    const evaluated = await this.rpc(
      "Runtime.evaluate",
      {
        expression: `(()=>{
      for(const transport of ["WebSocket","WebTransport","SharedWorker"])
        Object.defineProperty(globalThis,transport,{configurable:false,writable:false,value:class {
          constructor(){globalThis.__cmsWorkerTransportBlocked(transport);throw new Error("CMS connector blocks this worker transport.");}
        }});
      if(typeof navigator!=="undefined")
        Object.defineProperty(navigator,"serviceWorker",{configurable:false,get(){
          globalThis.__cmsWorkerTransportBlocked("ServiceWorker");
          return undefined;
        }});
    })()`,
        returnByValue: true,
      },
      sessionId,
    );
    if (evaluated.exceptionDetails) throw new Error("Worker transport guard failed");
  }
  private async start() {
    const socket = new WebSocket(this.cdpUrl, {
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 32 * 1024 * 1024,
    });
    this.upstream = socket;
    socket.on("message", (data) => this.receive(JSON.parse(data.toString())));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.disconnected = true;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Chrome disconnected"));
      }
      this.pending.clear();
      this.client?.close(1011, "Chrome disconnected");
    });
    await once(socket, "open");
    const version = await this.rpc("Browser.getVersion");
    if (!/^(Chrome|Chromium)\//.test(String(version.product)))
      throw new CmsError("unsupported_browser", "Connect to the existing Chrome browser.");
    const { targetId } = await this.rpc("Target.createTarget", {
      url: "about:blank",
      newWindow: false,
    });
    this.target = { targetId, type: "page", url: "about:blank", title: "" };
    const { targetInfo } = await this.rpc("Target.getTargetInfo", { targetId });
    this.target = targetInfo;
    const path = "/" + randomBytes(32).toString("hex");
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: false,
      verifyClient: (info: { origin: string }) => !info.origin,
    });
    this.server = server;
    server.on("connection", (client) => {
      if (this.client) {
        client.close(1008, "One connection only");
        return;
      }
      this.client = client;
      client.on("error", () => {});
      client.on("message", (data) => {
        let message: Message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          client.close(1008, "Invalid protocol");
          return;
        }
        void this.dispatch(message).then(
          (result) =>
            this.send({
              id: message.id,
              result,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            }),
          () =>
            this.send({
              id: message.id,
              error: { code: -32000, message: "Command is outside the owned CMS tab scope." },
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            }),
        );
      });
      client.on("close", () => {
        void this.close();
      });
    });
    await once(server, "listening");
    this.endpoint = "ws://127.0.0.1:" + (server.address() as AddressInfo).port + path;
  }
  private rpc(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Chrome disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chrome protocol timeout"));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.upstream!.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }
  private send(message: Message) {
    if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message));
  }
  private receive(message: Message) {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("Chrome rejected protocol command"));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const params = message.params!;
      const info = params.targetInfo as TargetInfo;
      const parent = message.sessionId;
      const isMain = !parent && info.targetId === this.target?.targetId;
      const isChild =
        !!parent && this.sessions.has(parent) && ["iframe", "worker"].includes(info.type);
      if (!isMain && !isChild) return;
      let origin: string | undefined;
      try {
        origin = new URL(info.url).origin;
      } catch {}
      if (!origin || origin === "null")
        origin = parent ? this.sessions.get(parent)?.origin : undefined;
      this.sessions.set(params.sessionId, {
        targetId: info.targetId,
        type: info.type,
        parent,
        origin,
      });
      if (isMain) this.mainSession = params.sessionId;
      // Worker globals do not receive Page.addInitScript or routeWebSocket.
      // Install their channel guard while Chrome still pauses startup, then give
      // Playwright the attachment and buffered Runtime events in protocol order.
      if (info.type === "worker") this.initializing.set(params.sessionId, []);
      const setup = !this.guardTransports
        ? Promise.resolve()
        : info.type === "worker"
          ? params.waitingForDebugger
            ? this.guardWorker(params.sessionId)
            : Promise.reject(new Error("Unpaused worker"))
          : this.rpc("Network.setBypassServiceWorker", { bypass: true }, params.sessionId);
      void setup
        .then(() => {
          this.send({
            ...message,
            params: { ...params, targetInfo: { ...info, browserContextId: "cms-owned-tab" } },
          });
          const buffered = this.initializing.get(params.sessionId) || [];
          this.initializing.delete(params.sessionId);
          for (const event of buffered) this.send(event);
          if (isMain) this.resolveMain?.();
        })
        .catch(() => {
          void this.close();
        });
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const id = message.params?.sessionId;
      if (!this.sessions.has(id)) return;
      this.sessions.delete(id);
      this.send(message);
      return;
    }
    if (message.sessionId) {
      const session = this.sessions.get(message.sessionId);
      if (!session) return;
      if (
        message.method === "Runtime.bindingCalled" &&
        message.params?.name === "__cmsWorkerTransportBlocked"
      ) {
        const transport = message.params.payload;
        if (
          session.origin === CMS_ORIGIN &&
          ["WebSocket", "WebTransport", "SharedWorker", "ServiceWorker"].includes(transport)
        )
          this.blockedTransports.add(transport);
        return;
      }
      const buffered = this.initializing.get(message.sessionId);
      if (buffered) {
        buffered.push(message);
        return;
      }
      if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) {
        try {
          session.origin = new URL(message.params!.frame.url).origin;
        } catch {}
      }
      this.send(message);
      return;
    }
    if (
      ["Target.targetInfoChanged", "Target.targetDestroyed", "Target.targetCrashed"].includes(
        message.method || "",
      )
    ) {
      const id = message.params?.targetId || message.params?.targetInfo?.targetId;
      if (id === this.target?.targetId) {
        if (message.params?.targetInfo) this.target = message.params.targetInfo;
        this.send(message);
      }
    }
  }
  private async dispatch(message: Message): Promise<any> {
    if (!Number.isSafeInteger(message.id) || typeof message.method !== "string")
      throw new Error("Invalid protocol");
    const method = message.method,
      params = message.params || {},
      sessionId = message.sessionId;
    if (sessionId) {
      if (!this.sessions.has(sessionId)) throw new Error("Unknown session");
      if (method === "Target.setAutoAttach") {
        return this.rpc(
          method,
          {
            autoAttach: params.autoAttach === true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [
              { type: "iframe", exclude: false },
              { type: "worker", exclude: false },
              { exclude: true },
            ],
          },
          sessionId,
        );
      }
      if (method === "Target.detachFromTarget") {
        if (!this.sessions.has(params.sessionId)) throw new Error("Unknown session");
        return this.rpc(method, { sessionId: params.sessionId }, sessionId);
      }
      if (method === "Network.getCookies") {
        const urls = params.urls || [CMS_ORIGIN];
        if (
          !Array.isArray(urls) ||
          !urls.every((url: string) => new URL(url).origin === CMS_ORIGIN)
        )
          throw new Error("Unrelated cookies");
        const result = await this.rpc(method, { urls }, sessionId);
        return { cookies: cmsCookies(result.cookies || []) };
      }
      if (method === "Network.setBypassServiceWorker" && params.bypass === true)
        return this.rpc(method, { bypass: true }, sessionId);
      if (!PAGE_METHODS.has(method)) throw new Error("Unsupported page command");
      return this.rpc(method, params, sessionId);
    }
    if (ROOT_READS.has(method)) return this.rpc(method, params);
    if (method === "Browser.setDownloadBehavior") return {}; // Never alter the user's browser-wide setting.
    if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
    if (method === "Target.getTargets")
      return {
        targetInfos: this.target ? [{ ...this.target, browserContextId: "cms-owned-tab" }] : [],
      };
    if (method === "Target.getTargetInfo") {
      if (params.targetId && params.targetId !== this.target?.targetId)
        throw new Error("Unowned target");
      const result = await this.rpc(method, { targetId: this.target!.targetId });
      return { targetInfo: { ...result.targetInfo, browserContextId: "cms-owned-tab" } };
    }
    if (method === "Target.setAutoAttach") {
      if (!params.autoAttach) return {};
      if (!this.mainReady) {
        this.mainReady = new Promise((resolve) => {
          this.resolveMain = resolve;
        });
        await this.rpc("Target.attachToTarget", { targetId: this.target!.targetId, flatten: true });
      }
      await this.mainReady;
      return {};
    }
    if (method === "Storage.getCookies") {
      if (!this.mainSession) return { cookies: [] };
      const result = await this.rpc("Network.getCookies", { urls: [CMS_ORIGIN] }, this.mainSession);
      return { cookies: cmsCookies(result.cookies || []) };
    }
    if (method === "Target.closeTarget") {
      if (params.targetId !== this.target?.targetId) throw new Error("Unowned target");
      return this.rpc(method, { targetId: this.target!.targetId });
    }
    throw new Error("Unsupported browser command");
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.target && !this.disconnected)
        await this.rpc("Target.closeTarget", { targetId: this.target.targetId }).catch(() => {});
      this.target = undefined;
      this.client?.terminate();
      if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.upstream?.terminate();
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Tether closed"));
      }
      this.pending.clear();
      this.sessions.clear();
      this.initializing.clear();
      this.resolveMain?.();
    })();
    return this.closing;
  }
}
export interface OwnedPageConnection {
  page: Page;
  close(): Promise<void>;
  unsupportedTransports?(): string[];
}
export async function connectOwnedPage(
  cdpUrl: string,
  guardTransports = true,
): Promise<OwnedPageConnection> {
  const gateway = await OwnedTargetGateway.open(cdpUrl, guardTransports);
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(gateway.endpointURL, { timeout: 20_000 });
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages.length !== 1) throw new Error("Expected exactly one owned tab");
    await pages[0].goto("about:blank", { waitUntil: "domcontentloaded" });
    return {
      page: pages[0],
      unsupportedTransports: () => gateway.unsupportedTransports(),
      close: async () => {
        // CDP-connected Browser.close disconnects its transport. The gateway alone
        // closes its immutable owned target; Browser.close is denied at the gateway.
        await browser?.close().catch(() => {});
        await gateway.close();
      },
    };
  } catch {
    await browser?.close().catch(() => {});
    await gateway.close();
    throw new CmsError(
      "browser_unavailable",
      "Could not attach the owned CMS tab. Keep your existing Chrome open with its local debugging connection enabled, then retry.",
    );
  }
}
