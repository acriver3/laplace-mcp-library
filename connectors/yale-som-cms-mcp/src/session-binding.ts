import { createHash } from "node:crypto";
import type { Page, Request } from "playwright-core";
import { CMS_ORIGIN, CmsError } from "./types.js";

// Observed through Network.getCookies({urls:[CMS_ORIGIN]}) on 2026-11-11:
// the tenant's .ASPXAUTH.Shared cookie is HttpOnly, Secure, and scoped to /.
// Do not guess other authentication cookie names or bind volatile telemetry cookies.
const AUTH_COOKIE = ".ASPXAUTH.Shared";
const HOST = new URL(CMS_ORIGIN).hostname;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const changed = () =>
  new CmsError(
    "account_changed",
    "Chrome's CMS sign-in changed after the preview. No blocked request was sent. Prepare and confirm a fresh preview in the intended account.",
  );
const unavailable = () =>
  new CmsError(
    "session_binding_unavailable",
    "The current CMS sign-in could not be bound to this request. No blocked request was sent. Sign in again and prepare a fresh preview.",
  );

/** Keeps only hashes of the observed CMS authentication cookie in process memory.
 * No cookie values, headers or fingerprints are returned in tool data or errors.
 * The page's context is the owned-target gateway, which exposes CMS cookies only.
 */
export class SessionBinding {
  private identitySession?: string;
  private activeSession?: string;
  constructor(private readonly page: () => Promise<Page>) {}

  private async current(): Promise<string> {
    try {
      const page = await this.page();
      const cookies = await page.context().cookies(CMS_ORIGIN);
      const auth = cookies.filter((cookie) => cookie.name === AUTH_COOKIE);
      if (
        auth.length !== 1 ||
        !auth[0].value ||
        !auth[0].httpOnly ||
        !auth[0].secure ||
        auth[0].path !== "/" ||
        auth[0].domain.replace(/^\./, "").toLowerCase() !== HOST
      )
        throw unavailable();
      return digest(auth[0].value);
    } catch {
      throw unavailable();
    }
  }

  async identityKey(accountKey: string): Promise<string> {
    const session = await this.current();
    this.identitySession = session;
    return digest(JSON.stringify([accountKey, session]));
  }

  async begin(): Promise<void> {
    if (this.activeSession)
      throw new CmsError(
        "mutation_in_progress",
        "A confirmed CMS change is already running.",
      );
    if (!this.identitySession) throw unavailable();
    const session = await this.current();
    if (session !== this.identitySession) throw changed();
    this.activeSession = session;
  }

  async assertRequest(request: Request): Promise<void> {
    const expected = this.activeSession;
    if (!expected || new URL(request.url()).origin !== CMS_ORIGIN)
      throw unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let header: string | null;
    try {
      // Intercepted Chromium requests already have raw headers from Fetch.requestPaused
      // before Playwright invokes route callbacks. A bounded wait also fails closed
      // if a future browser transport stops providing these headers while paused.
      header = await Promise.race([
        request.headerValue("cookie"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable()), 2000);
        }),
      ]);
    } catch {
      throw unavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
    const values = (header || "").split(";").flatMap((part) => {
      const pair = part.trim();
      const equal = pair.indexOf("=");
      return equal >= 0 && pair.slice(0, equal) === AUTH_COOKIE
        ? [pair.slice(equal + 1)]
        : [];
    });
    if (values.length !== 1 || !values[0]) throw unavailable();
    if (digest(values[0]) !== expected) throw changed();
    // Also reject a sign-in switch that happened after the request's Cookie header
    // was assembled. Never copy a cookie into a request or override Chrome's jar.
    if ((await this.current()) !== expected) throw changed();
    if (this.activeSession !== expected) throw changed();
  }

  end(): void {
    this.activeSession = undefined;
  }
  clear(): void {
    this.end();
    this.identitySession = undefined;
  }
}
