import type { Locator, Page, Request, Response } from "playwright-core";

import { isReadRequest } from "./browser.js";
import { CMS_ORIGIN, CmsError } from "./types.js";

export interface CompletionOptions {
  /** The already-visible form or final control; disappearance is a completion hint. */
  form?: Locator;
  finalControl?: Locator;
  /** Only this same-origin destination counts as navigation evidence. */
  expectedUrl?: string | RegExp;
  /** Starts after the bounded action returns, never while it may still mutate. */
  timeoutMs?: number;
  /** Quiet period after the last tracked request and positive completion evidence. */
  settleMs?: number;
}

async function visible(locator: Locator): Promise<boolean> {
  return (await locator.count()) === 1 && await locator.isVisible();
}
async function disappeared(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  // A new ambiguous match is not evidence that the approved form went away.
  return count === 0 || count === 1 && !await locator.isVisible();
}

/** Observe transport/UI completion before a caller navigates to verify persisted state.
 * This does not assert that CMS accepted the operation, even for a 2xx response.
 * The action runs exactly once and must use its own bounded Playwright/upload waits.
 * It is fully awaited before the completion deadline starts: no timed-out callback
 * is left running later mutation steps. No requests or navigations are initiated here.
 */
export async function observeCompletion<T>(
  page: Page,
  action: () => Promise<T>,
  options: CompletionOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(settleMs) || settleMs < 0 || settleMs >= timeoutMs)
    throw new CmsError("invalid_configuration", "Completion requires a finite positive timeout and a shorter nonnegative settle period.");
  const startUrl = page.url();
  const initiallyVisible: Locator[] = [];
  for (const locator of [options.form, options.finalControl])
    if (locator && await visible(locator)) initiallyVisible.push(locator);

  const pending = new Set<Request>();
  let completedWrites = 0;
  let failedWrite = false;
  let activity = 0;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== CMS_ORIGIN || isReadRequest(request.method(), request.url())) return;
    pending.add(request);
    activity++;
  };
  const onFinished = (request: Request) => {
    if (!pending.delete(request)) return;
    completedWrites++;
    activity++;
  };
  const onResponse = (response: Response) => {
    // These statuses have no response body by HTTP definition. Chromium can
    // subsequently label a fulfilled 204 as net::ERR_ABORTED; headers already
    // completed this transport, without proving the intended CMS outcome.
    if ([204, 205, 304].includes(response.status())) onFinished(response.request());
  };
  const onFailed = (request: Request) => {
    if (!pending.delete(request)) return;
    failedWrite = true;
    activity++;
  };
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  try {
    let result!: T;
    let actionFailed = false;
    let actionError: unknown;
    try { result = await action(); }
    catch (error) { actionFailed = true; actionError = error; }

    await new Promise<void>((accept, reject) => {
      let ended = false;
      let poll: ReturnType<typeof setTimeout> | undefined;
      let stableSince: number | undefined;
      let lastActivity = activity;
      const finish = (error?: unknown) => {
        if (ended) return;
        ended = true;
        clearTimeout(deadline);
        clearTimeout(poll);
        if (error) reject(error); else accept();
      };
      const uncertain = (reason: string) => new CmsError(
        "submission_uncertain",
        "CMS submission completion could not be established. Inspect the record before another change; this action was not retried.",
        { reason, pending_requests: pending.size },
      );
      const deadline = setTimeout(() => finish(uncertain("completion_timeout")), timeoutMs);
      const check = async () => {
        if (ended) return;
        try {
          if (page.isClosed()) return finish(uncertain("page_closed"));
          const url = new URL(page.url());
          if (url.origin !== CMS_ORIGIN) return finish(uncertain("external_navigation"));
          let expectedNavigation = false;
          if (options.expectedUrl && url.href !== startUrl) {
            if (typeof options.expectedUrl === "string") expectedNavigation = url.href === options.expectedUrl;
            else {
              options.expectedUrl.lastIndex = 0;
              expectedNavigation = options.expectedUrl.test(url.href);
            }
          }
          let formGone = false;
          for (const locator of initiallyVisible)
            if (await disappeared(locator)) { formGone = true; break; }
          if (ended) return;
          const evidence = actionFailed || failedWrite || completedWrites > 0 || formGone || expectedNavigation;
          if (activity !== lastActivity || pending.size || !evidence) stableSince = undefined;
          lastActivity = activity;
          if (!pending.size && evidence) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= settleMs) {
              if (failedWrite) return finish(uncertain("request_failed"));
              return finish();
            }
          }
        } catch {
          // Navigation can destroy the old execution context. The outer deadline
          // remains active; inspect the next document instead of assuming success.
          stableSince = undefined;
        }
        if (!ended) poll = setTimeout(() => { void check(); }, 25);
      };
      void check();
    });
    if (actionFailed) throw actionError;
    return result;
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
  }
}
