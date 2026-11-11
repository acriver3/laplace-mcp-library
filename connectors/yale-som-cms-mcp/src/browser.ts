import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { CMS_ORIGIN, DASHBOARD, CmsError, type Identity } from './types.js';

export const DEFAULT_PROFILE = resolve(homedir(), '.laplace-local/sessions/yale-som-cms/profile');
export const DEFAULT_DOWNLOADS = resolve(homedir(), 'Documents/Yale SOM CMS');
const isInside = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

/** A separate owner file prevents login, status and serving from racing the profile. */
export class ProfileLock {
  readonly file: string;
  private readonly token = randomUUID();
  private acquired = false;
  constructor(profile: string) { this.file = `${resolve(profile)}.owner.json`; }
  async acquire() {
    if (this.acquired) return;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new CmsError('profile_busy', 'The CMS profile is owned by another process. Stop that process and its browser before releasing a stale lock.');
      throw error;
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, platform: process.platform, token: this.token }));
      this.acquired = true;
    } finally { await file.close(); }
  }
  async release() {
    if (!this.acquired) return;
    const owner = JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}'));
    if (owner.token === this.token) await unlink(this.file);
    this.acquired = false;
  }
  async releaseStale() {
    const owner = JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.platform !== process.platform)
      throw new CmsError('profile_busy', 'Cannot verify the profile owner; inspect the owner file locally.');
    try {
      process.kill(owner.pid, 0);
      throw new CmsError('profile_busy', 'The CMS profile owner is still running.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await unlink(this.file);
  }
}

export class CmsBrowser {
  readonly profile: string;
  readonly downloadsDir: string;
  readonly lock: ProfileLock;
  private readonly packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  private context?: BrowserContext;
  private currentPage?: Page;
  private opening?: Promise<Page>;
  private names = new Map<string, string>();
  constructor(
    profileDir = DEFAULT_PROFILE,
    readonly channel: 'chrome' | 'msedge' = 'chrome',
    readonly headed = false,
    downloadsDir = DEFAULT_DOWNLOADS,
  ) {
    if (!['chrome', 'msedge'].includes(channel)) throw new CmsError('invalid_browser', 'Choose chrome or msedge.');
    this.profile = resolve(profileDir);
    this.downloadsDir = resolve(downloadsDir);
    if (isInside(this.packageRoot, this.profile) || this.profile === homedir() || dirname(this.profile) === this.profile ||
        /(?:Google[\\/]Chrome|Microsoft[\\/]Edge|Chromium)[\\/](?:User Data|Default)(?:[\\/]|$)/i.test(this.profile))
      throw new CmsError('invalid_profile', 'Choose a dedicated CMS profile outside the installed package and everyday browser profiles.');
    this.lock = new ProfileLock(this.profile);
  }
  async page(): Promise<Page> {
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    if (!this.opening) this.opening = this.open().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async open(): Promise<Page> {
    let ancestor = this.profile;
    while (true) {
      try { await realpath(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    const target = resolve(await realpath(ancestor), relative(ancestor, this.profile));
    if (isInside(await realpath(this.packageRoot), target))
      throw new CmsError('invalid_profile', 'The resolved CMS profile must stay outside the installed package.');
    await this.lock.acquire();
    try {
      await mkdir(this.profile, { recursive: true, mode: 0o700 });
      this.context = await chromium.launchPersistentContext(this.profile, {
        channel: this.channel, headless: !this.headed,
        args: ['--restore-last-session'], viewport: { width: 1440, height: 1000 },
        acceptDownloads: true, timeout: 30_000,
      });
      this.context.setDefaultTimeout(15_000);
      this.context.setDefaultNavigationTimeout(30_000);
      this.currentPage = this.context.pages()[0] || await this.context.newPage();
      for (const page of this.context.pages()) if (page !== this.currentPage) await page.close({ runBeforeUnload: false });
      this.currentPage.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      return this.currentPage;
    } catch (error) {
      await this.close();
      if (error instanceof CmsError) throw error;
      throw new CmsError('browser_unavailable', 'Could not launch the dedicated CMS browser. Install the selected Chrome/Edge channel and stop other processes using this profile.');
    }
  }
  async identity(): Promise<Identity> {
    const page = await this.page();
    if (page.url() === 'about:blank') await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== CMS_ORIGIN)
      throw new CmsError('auth_required', 'Run login with this same profile and browser, complete Yale/12twenty sign-in yourself, then restart the server.');
    await page.waitForFunction(() => !!(window as any).TT?.CurrentSession?.CurrentUser?.Id && document.body.classList.contains('logged-in-user'), undefined, { timeout: 10_000 }).catch(() => {});
    const found = await page.evaluate(() => {
      const user = (window as any).TT?.CurrentSession?.CurrentUser;
      if (!user?.Id || !document.body.classList.contains('logged-in-user') || !document.querySelector('a[href*="/students/profile"]')) return null;
      const heading = location.pathname.toLowerCase().startsWith('/students/profile') ? document.querySelector('[role=main] h1,main h1') : null;
      const name = heading ? [...heading.childNodes].filter(x => x.nodeType === Node.TEXT_NODE).map(x => x.textContent).join(' ').replace(/\s+/g, ' ').trim() : '';
      return { id: String(user.Id), name };
    });
    if (!found) throw new CmsError('auth_required', 'The CMS session expired or sign-in is incomplete. Run login with this same dedicated profile and complete Yale/12twenty sign-in yourself.');
    if (found.name) this.names.set(found.id, found.name);
    return { key: createHash('sha256').update(`${CMS_ORIGIN}\n${found.id}`).digest('hex'), account_id: found.id, name: this.names.get(found.id) || `Yale SOM account ${found.id}` };
  }
  async login(timeoutMs = 1_800_000): Promise<Identity> {
    if (!this.headed) throw new CmsError('interactive_login_required', 'Login requires the headed login command. Serving always uses the saved profile headlessly.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new CmsError('invalid_timeout', 'Login timeout must be 1–3600 seconds.');
    const page = await this.page();
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(origin => location.origin === origin && !!(window as any).TT?.CurrentSession?.CurrentUser?.Id && document.body.classList.contains('logged-in-user'), CMS_ORIGIN, { timeout: timeoutMs });
    } catch { throw new CmsError('auth_required', 'Interactive sign-in did not finish. Run login again when ready to complete Yale/12twenty sign-in.'); }
    await page.goto(`${CMS_ORIGIN}/students/profile`, { waitUntil: 'domcontentloaded' });
    return this.identity();
  }
  async close() {
    const context = this.context;
    this.context = undefined;
    this.currentPage = undefined;
    this.names.clear();
    try { await context?.close(); } finally { await this.lock.release(); }
  }
}
