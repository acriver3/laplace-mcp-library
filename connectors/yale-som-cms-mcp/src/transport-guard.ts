import type { Page } from "playwright-core";

import { CMS_ORIGIN } from "./types.js";

/** Only the connector-owned tab is changed. Existing Chrome workers and sockets
 * remain untouched. Read/search success may ignore optional blocked telemetry;
 * callers can report an explicit unsupported transport when page work fails.
 */
export async function installTransportGuard(page: Page, report: (transport: string) => void) {
  await page.exposeBinding(
    "__cmsReportBlockedTransport",
    ({ frame }, transport: string, url?: string) => {
      if (!["SharedWorker", "ServiceWorker", "WebTransport"].includes(transport)) return;
      try {
        const source = new URL(frame.url());
        const destination = url ? new URL(url, source) : source;
        if (source.origin === CMS_ORIGIN && destination.origin === CMS_ORIGIN) report(transport);
      } catch {}
    },
  );
  await page.addInitScript(() => {
    const notify = (transport: string, url?: unknown) => {
      void (globalThis as any)
        .__cmsReportBlockedTransport(transport, url === undefined ? undefined : String(url))
        .catch(() => {});
    };
    const deny = (transport: string, url?: unknown): never => {
      notify(transport, url);
      throw new Error("CMS connector cannot safely use this " + transport + " channel.");
    };
    for (const transport of ["SharedWorker", "WebTransport"])
      Object.defineProperty(globalThis, transport, {
        configurable: false,
        writable: false,
        value: class {
          constructor(url: unknown) {
            deny(transport, url);
          }
        },
      });
    // Existing service workers can send requests on postMessage independently of
    // page interception. Never expose those shared controllers to a guarded tab.
    const serviceWorker = {
      register(url: unknown) {
        try {
          deny("ServiceWorker", url);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      get controller() {
        notify("ServiceWorker");
        return null;
      },
      get ready() {
        notify("ServiceWorker");
        return Promise.reject(new Error("CMS connector blocks shared service-worker channels."));
      },
      getRegistration() {
        notify("ServiceWorker");
        return Promise.resolve(undefined);
      },
      getRegistrations() {
        notify("ServiceWorker");
        return Promise.resolve([]);
      },
      addEventListener() {},
      removeEventListener() {},
      startMessages() {},
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: false,
      get: () => serviceWorker,
    });
  });
  await page.routeWebSocket("**/*", (socket) => {
    try {
      const url = new URL(socket.url());
      if (url.hostname === new URL(CMS_ORIGIN).hostname) report("WebSocket");
    } catch {}
    // Not calling connectToServer prevents a network connection, including any
    // messages that could change student data outside HTTP request interception.
    void socket.close({ code: 1008, reason: "Unreviewed connector channel" });
  });
}
