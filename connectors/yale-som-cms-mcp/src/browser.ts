import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, type Route, type Request } from "playwright-core";
import { connectOwnedPage, DEFAULT_CDP_URL, validateCdpUrl, type OwnedPageConnection } from "./tether.js";
export { DEFAULT_CDP_URL, validateCdpUrl } from "./tether.js";
import { installTransportGuard } from "./transport-guard.js";
import { SessionBinding } from "./session-binding.js";
import {
  CMS_ORIGIN,
  DASHBOARD,
  TIMEZONE,
  CmsError,
  type Identity,
} from "./types.js";

export const DEFAULT_STATE = resolve(
  homedir(),
  ".laplace-local/sessions/yale-som-cms/state",
);
/** Deprecated name: this is local connector state, never a Chrome profile. */
export const DEFAULT_PROFILE = DEFAULT_STATE;
export const DEFAULT_DOWNLOADS = resolve(homedir(), "Documents/Yale SOM CMS");
const isInside = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return (
    !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
};

/** A separate owner file prevents login, status and serving from racing the profile. */
export class ProfileLock {
  readonly file: string;
  private readonly token = randomUUID();
  private acquired = false;
  constructor(profile: string) {
    this.file = `${resolve(profile)}.owner.json`;
  }
  async acquire() {
    if (this.acquired) return;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let file;
    try {
      file = await open(this.file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new CmsError(
          "profile_busy",
          "The CMS state directory is in use by another connector process. Stop that process before releasing a stale lock.",
        );
      throw error;
    }
    try {
      await file.writeFile(
        JSON.stringify({
          pid: process.pid,
          platform: process.platform,
          token: this.token,
        }),
      );
      this.acquired = true;
    } finally {
      await file.close();
    }
  }
  async release() {
    if (!this.acquired) return;
    const owner = JSON.parse(
      await readFile(this.file, "utf8").catch(() => "{}"),
    );
    if (owner.token === this.token) await unlink(this.file);
    this.acquired = false;
  }
  async releaseStale() {
    const owner = JSON.parse(
      await readFile(this.file, "utf8").catch(() => "{}"),
    );
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      owner.platform !== process.platform
    )
      throw new CmsError(
        "profile_busy",
        "Cannot verify the profile owner; inspect the owner file locally.",
      );
    try {
      process.kill(owner.pid, 0);
      throw new CmsError(
        "profile_busy",
        "The CMS connector state owner is still running.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await unlink(this.file);
  }
}

/** POST endpoints observed during authenticated student read discovery, 2026-11-11.
 * These query existing data. Never allow an arbitrary endpoint merely because its name
 * contains "query". Numeric resume-book IDs are the observed route parameter.
 */
const READ_POST_PATHS = new Set([
  "/api/internal/entity-short-summaries",
  "/api/internal/job-analytics/job-counts-by-attribute",
  "/api/internal/job-analytics/pay-category-stats",
  "/api/internal/job-analytics/salary-trends",
  "/api/internal/tasks/post-query",
  "/api/v2/activity-stream/recent-companies",
  "/api/v2/activity-stream/recent-contacts",
  "/api/v2/appointment-calendar-events/available-appointment-types-colleges/post-query",
  "/api/v2/appointment-calendar-events/post-query",
  "/api/v2/appointment-blocks/available-booking-times",
  "/api/v2/companies/metrics",
  "/api/v2/companies/query",
  "/api/v2/educations/post-query",
  "/api/v2/events/post-query",
  "/api/v2/job-postings/post-query",
  "/companies/getcontacts",
]);

/** The same reviewed classifier is shared by read protection and write verification. */
export function isReadRequest(method: string, requestUrl: string): boolean {
  method = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  const path = url.pathname.toLowerCase();
  return (
    url.origin === CMS_ORIGIN &&
    method === "POST" &&
    (READ_POST_PATHS.has(path) ||
      /^\/api\/v2\/resume-books\/\d+\/items\/query$/.test(path))
  );
}

const CHALLENGE_PATH = "/cdn-cgi/challenge-platform/";
const CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";

/** Cloudflare serves reserved challenge infrastructure on the tenant and its own host.
 * https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/
 * https://developers.cloudflare.com/turnstile/reference/content-security-policy/
 * Let the browser run its supplied scripts normally; this does not solve interactive
 * challenges, forge clearance, or authorize any student-data endpoint. The route is
 * passed through unchanged, so the browser retains normal origin/cookie isolation.
 */
export function isInfrastructureRequest(method: string, requestUrl: string): boolean {
  if (!["GET", "HEAD", "OPTIONS", "POST"].includes(method.toUpperCase())) return false;
  try {
    const url = new URL(requestUrl);
    if (
      ![CMS_ORIGIN, CHALLENGE_ORIGIN].includes(url.origin) ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(CHALLENGE_PATH)
    )
      return false;
    // Inspect before URL normalization as well: encoded separators and dot segments
    // must never escape the reserved subtree after an intermediary decodes the URL.
    const rawPath = requestUrl.match(/^https:\/\/[^/?#]+(\/[^?#]*)?(?:[?#]|$)/i)?.[1];
    if (!rawPath?.startsWith(CHALLENGE_PATH)) return false;
    const decoded = decodeURIComponent(rawPath);
    return (
      decoded.startsWith(CHALLENGE_PATH) &&
      !decoded.includes("\\") &&
      !decoded.includes("%") &&
      !decoded.split("/").some((part) => part === "." || part === "..")
    );
  } catch {
    return false;
  }
}

function requestErrorPath(url: URL): string {
  const path = url.pathname.toLowerCase();
  // The suffix contains transient challenge identifiers. Never return it in a
  // tool error, including when an unsupported method or malformed path is denied.
  return path.startsWith("/cdn-cgi/challenge-platform") ? CHALLENGE_PATH + "[redacted]" : path;
}

/** Installed for every status/serve context, including after a preview ends. */
export class ReadRequestGuard {
  private mutationActive = false;
  private unsafeFailure?: unknown;
  private blocked = new Map<string, { method: string; path: string }>();
  constructor(private readonly beforeUnsafeRequest?: (request: Request) => Promise<void>) {}
  async handle(route: Route) {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    if (isReadRequest(method, url.href) || isInfrastructureRequest(method, request.url()))
      return route.fallback();
    const sameTenant = url.origin === CMS_ORIGIN;
    const path = requestErrorPath(url);
    if (sameTenant && this.mutationActive) {
      try {
        if (this.unsafeFailure) return route.abort("blockedbyclient");
        await this.beforeUnsafeRequest?.(request);
        if (this.unsafeFailure || !this.mutationActive) {
          if (!this.mutationActive) this.blocked.set(method + " " + path, { method, path });
          return route.abort("blockedbyclient");
        }
        return route.fallback();
      } catch (error) {
        this.unsafeFailure ??= error;
        return route.abort("blockedbyclient");
      }
    }
    // Third-party telemetry is blocked silently. An unknown CMS request must be
    // reviewed explicitly; strip query strings and never inspect auth headers/body.
    if (sameTenant) this.blocked.set(method + " " + path, { method, path });
    return route.abort("blockedbyclient");
  }
  assertReadRequests() {
    const failure = this.unsafeFailure;
    this.unsafeFailure = undefined;
    const requests = [...this.blocked.values()];
    this.blocked.clear();
    if (failure) throw failure;
    if (requests.length)
      throw new CmsError(
        "read_request_unreviewed",
        "A CMS request was blocked because it has not been verified as read-only. No request in this list was sent. Reauthenticate manually if the request belongs to sign-in.",
        { requests },
      );
  }
  async runMutation<T>(callback: () => Promise<T>): Promise<T> {
    if (this.mutationActive)
      throw new CmsError(
        "mutation_in_progress",
        "Only one confirmed CMS change can run at a time.",
      );
    this.assertReadRequests();
    this.mutationActive = true;
    try {
      return await callback();
    } finally {
      this.mutationActive = false;
      this.assertReadRequests();
    }
  }
}

export class CmsBrowser {
  readonly profile: string;
  readonly stateDir: string;
  readonly downloadsDir: string;
  readonly lock: ProfileLock;
  private readonly packageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  private attachment?: OwnedPageConnection;
  private readonly sessionBinding = new SessionBinding(() => this.page());
  private readonly readGuard = new ReadRequestGuard(request => this.sessionBinding.assertRequest(request));
  private currentPage?: Page;
  private browserChallenge = false;
  private unsupportedTransports = new Set<string>();
  private opening?: Promise<Page>;
  private closing?: Promise<void>;
  private generation = 0;
  private names = new Map<string, string>();
  constructor(
    stateDir = DEFAULT_STATE,
    readonly cdpUrl = DEFAULT_CDP_URL,
    readonly interactiveLogin = false,
    downloadsDir = DEFAULT_DOWNLOADS,
  ) {
    this.cdpUrl = validateCdpUrl(cdpUrl);
    this.stateDir = resolve(stateDir);
    this.profile = this.stateDir;
    this.downloadsDir = resolve(downloadsDir);
    if (
      isInside(this.packageRoot, this.profile) ||
      this.profile === homedir() ||
      dirname(this.profile) === this.profile ||
      /(?:Google[\\/]Chrome|Microsoft[\\/]Edge|Chromium)[\\/](?:User Data|Default)(?:[\\/]|$)/i.test(
        this.profile,
      )
    )
      throw new CmsError(
        "invalid_profile",
        "Choose a dedicated local state directory outside the installed package and Chrome profiles.",
      );
    this.lock = new ProfileLock(this.profile);
  }
  async page(): Promise<Page> {
    if (this.closing) await this.closing;
    if (this.currentPage && !this.currentPage.isClosed())
      return this.currentPage;
    if (!this.opening)
      this.opening = this.open().finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }
  protected async connectOwnedPage(): Promise<OwnedPageConnection> {
    return connectOwnedPage(this.cdpUrl, !this.interactiveLogin);
  }
  private async open(): Promise<Page> {
    const generation = this.generation;
    let attachment: OwnedPageConnection | undefined;
    let ancestor = this.profile;
    while (true) {
      try {
        await realpath(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    const target = resolve(
      await realpath(ancestor),
      relative(ancestor, this.profile),
    );
    if (
      isInside(await realpath(this.packageRoot), target) ||
      target === homedir() ||
      dirname(target) === target ||
      /(?:Google[\\/]Chrome|Microsoft[\\/]Edge|Chromium)[\\/](?:User Data|Default)(?:[\\/]|$)/i.test(
        target,
      )
    )
      throw new CmsError(
        "invalid_profile",
        "The resolved CMS state directory must be outside the installed package and Chrome profiles.",
      );
    await this.lock.acquire();
    try {
      await mkdir(this.profile, { recursive: true, mode: 0o700 });
      await this.attachment?.close();
      this.attachment = undefined;
      this.currentPage = undefined;
      this.unsupportedTransports.clear();
      attachment = await this.connectOwnedPage();
      if (generation !== this.generation)
        throw new CmsError("browser_closed", "CMS browser attachment was cancelled.");
      this.attachment = attachment;
      this.currentPage = attachment.page;
      if (!this.interactiveLogin) {
        await this.currentPage.route("**/*", (route) => this.readGuard.handle(route));
        await installTransportGuard(this.currentPage,transport=>this.unsupportedTransports.add(transport));
      }
      this.currentPage.setDefaultTimeout(15_000);
      this.currentPage.setDefaultNavigationTimeout(30_000);
      if (generation !== this.generation)
        throw new CmsError("browser_closed", "CMS browser attachment was cancelled.");
      this.currentPage.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      this.browserChallenge = false;
      const page = this.currentPage;
      // Cloudflare documents this header for every Challenge Page type. Observe
      // only main-document navigations: a challenged iframe or API response does
      // not establish that the current CMS page is blocked.
      // https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
      page.on("response", (response) => {
        const request = response.request();
        if (
          page !== this.currentPage ||
          !request.isNavigationRequest() ||
          request.frame() !== page.mainFrame()
        )
          return;
        this.browserChallenge = response.headers()["cf-mitigated"] === "challenge";
      });
      return this.currentPage;
    } catch (error) {
      if (this.attachment === attachment) {
        this.attachment = undefined;
        this.currentPage = undefined;
      }
      try {
        await attachment?.close();
      } finally {
        await this.lock.release();
      }
      if (error instanceof CmsError) throw error;
      throw new CmsError(
        "browser_unavailable",
        "Could not attach to your existing Chrome. Keep Chrome open with its local debugging connection enabled, then retry.",
      );
    }
  }
  assertReadRequests() {
    this.readGuard.assertReadRequests();
  }
  async runMutation<T>(callback: () => Promise<T>): Promise<T> {
    await this.sessionBinding.begin();
    try {
      return await this.readGuard.runMutation(callback);
    } finally {
      this.sessionBinding.end();
    }
  }
  assertSupportedTransports() {
    const transports = new Set([...this.unsupportedTransports, ...(this.attachment?.unsupportedTransports?.() || [])]);
    if(transports.size)
      throw new CmsError("unsupported_transport","This CMS operation requires a browser channel that cannot be safely isolated to the connector's tab. Complete it manually in CMS.",{transports:[...transports].sort()});
  }
  private assertNoBrowserChallenge() {
    if (this.browserChallenge)
      throw new CmsError(
        "browser_challenge",
        "Cloudflare returned a browser challenge before CMS could verify the saved session. The saved login may still be valid. Complete the check yourself in the visible connector browser, then retry while that window is open. If the site continues to block access, use CMS manually or ask Yale/12twenty for supported access.",
        { provider: "cloudflare", saved_login_status: "unknown" },
      );
  }
  async identity(): Promise<Identity> {
    const page = await this.page();
    if (page.url() === "about:blank")
      await page.goto(DASHBOARD, { waitUntil: "domcontentloaded" });
    if (new URL(page.url()).origin !== CMS_ORIGIN) {
      this.assertNoBrowserChallenge();
      throw new CmsError(
        "auth_required",
        "Complete Yale/12twenty sign-in yourself in Chrome, then retry. Run login to open a connector-owned CMS tab if needed.",
      );
    }
    await page
      .waitForFunction(
        () =>
          !!(window as any).TT?.CurrentSession?.CurrentUser?.Id &&
          document.body.classList.contains("logged-in-user"),
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {});
    this.assertNoBrowserChallenge();
    const found = await page.evaluate(() => {
      const user = (window as any).TT?.CurrentSession?.CurrentUser;
      if (
        !user?.Id ||
        !document.body.classList.contains("logged-in-user") ||
        !document.querySelector('a[href*="/students/profile"]')
      )
        return null;
      const heading = location.pathname
        .toLowerCase()
        .startsWith("/students/profile")
        ? document.querySelector("[role=main] h1,main h1")
        : null;
      const name = heading
        ? [...heading.childNodes]
            .filter((x) => x.nodeType === Node.TEXT_NODE)
            .map((x) => x.textContent)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        : "";
      return { id: String(user.Id), name, type: user.TypeId };
    });
    if (!found) {
      this.assertSupportedTransports();
      throw new CmsError(
        "auth_required",
        "The attached Chrome session is not signed in to CMS. Complete Yale/12twenty sign-in yourself in the connector's tab, then retry.",
      );
    }
    if (found.type !== 2)
      throw new CmsError(
        "account_not_student",
        "Use a Yale SOM student account in the attached Chrome session. Employer and administrator actions are outside this connector.",
      );
    if (found.name) this.names.set(found.id, found.name);
    return {
      key: await this.sessionBinding.identityKey(createHash("sha256")
        .update(`${CMS_ORIGIN}\n${found.id}`)
        .digest("hex")),
      account_id: found.id,
      name: this.names.get(found.id) || `Yale SOM account ${found.id}`,
    };
  }
  async login(timeoutMs = 1_800_000): Promise<Identity> {
    if (!this.interactiveLogin)
      throw new CmsError(
        "interactive_login_required",
        "Interactive sign-in is available only through the explicit login command. Status and serving use a visible browser with student writes guarded.",
      );
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 3_600_000
    )
      throw new CmsError(
        "invalid_timeout",
        "Login timeout must be 1–3600 seconds.",
      );
    const page = await this.page();
    await page.goto(DASHBOARD, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        (origin) =>
          location.origin === origin &&
          !!(window as any).TT?.CurrentSession?.CurrentUser?.Id &&
          document.body.classList.contains("logged-in-user"),
        CMS_ORIGIN,
        { timeout: timeoutMs },
      );
    } catch {
      this.assertNoBrowserChallenge();
      throw new CmsError(
        "auth_required",
        "Interactive sign-in did not finish. Run login again when ready to complete Yale/12twenty sign-in.",
      );
    }
    await page.goto(`${CMS_ORIGIN}/students/profile`, {
      waitUntil: "domcontentloaded",
    });
    return this.identity();
  }
  async close() {
    if (this.closing) return this.closing;
    const opening = this.opening;
    this.generation++;
    this.closing = (async () => {
      // A late attachment closes only its owned tab before releasing the state lease.
      await opening?.catch(() => {});
      const attachment = this.attachment;
      this.attachment = undefined;
      this.currentPage = undefined;
      this.browserChallenge = false;
      this.unsupportedTransports.clear();
      this.sessionBinding.clear();
      this.names.clear();
      try {
        await attachment?.close();
      } finally {
        await this.lock.release();
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
