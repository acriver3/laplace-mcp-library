import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, realpath, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { EMS_BASE, EmsError } from "./types.js";
export const DEFAULT_PROFILE = resolve(homedir(), ".laplace-local/sessions/yale-som-ems/profile");
export class ProfileLock {
    token = randomUUID();
    acquired = false;
    file;
    constructor(profile) {
        this.file = `${resolve(profile)}.owner.json`;
    }
    async acquire() {
        if (this.acquired)
            return;
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        let file;
        try {
            file = await open(this.file, "wx", 0o600);
        }
        catch (error) {
            if (error.code === "EEXIST")
                throw new EmsError("profile_busy", "Another process owns this EMS profile, or it did not shut down cleanly. Stop it first; status --release-stale-lock can release a dead owner.");
            throw error;
        }
        try {
            await file.writeFile(JSON.stringify({ pid: process.pid, platform: process.platform, token: this.token }));
            this.acquired = true;
        }
        finally {
            await file.close();
        }
    }
    async release() {
        if (!this.acquired)
            return;
        const owner = JSON.parse(await readFile(this.file, "utf8").catch(() => "{}"));
        if (owner.token === this.token)
            await unlink(this.file);
        this.acquired = false;
    }
    async releaseStale() {
        const owner = JSON.parse(await readFile(this.file, "utf8").catch(() => "{}"));
        if (!owner.pid || owner.platform !== process.platform)
            throw new EmsError("profile_busy", "Cannot verify the profile owner. Inspect the lock locally.");
        try {
            process.kill(owner.pid, 0);
            throw new EmsError("profile_busy", "The profile owner is still running.");
        }
        catch (e) {
            if (e.code !== "ESRCH")
                throw e;
        }
        await unlink(this.file);
    }
}
export class EmsBrowser {
    channel;
    headed;
    profile;
    lock;
    context;
    currentPage;
    packageRoot;
    constructor(profile = DEFAULT_PROFILE, channel = "chrome", headed = false) {
        this.channel = channel;
        this.headed = headed;
        this.profile = resolve(profile);
        const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        this.packageRoot = packageRoot;
        const rel = relative(packageRoot, this.profile);
        if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
            throw new EmsError("invalid_profile", "Choose a dedicated profile outside the bundle directory.");
        if (this.profile === homedir() || this.profile === resolve("/"))
            throw new EmsError("invalid_profile", "Choose a dedicated EMS profile directory.");
        this.lock = new ProfileLock(this.profile);
    }
    async page() {
        if (this.currentPage && !this.currentPage.isClosed())
            return this.currentPage;
        // Resolve existing ancestors before creating a profile or its lock. A symlink
        // must not put sessions back inside the bundle's archive boundary.
        let ancestor = this.profile;
        while (true) {
            try {
                await realpath(ancestor);
                break;
            }
            catch (e) {
                if (e.code !== "ENOENT")
                    throw e;
                const parent = dirname(ancestor);
                if (parent === ancestor)
                    throw e;
                ancestor = parent;
            }
        }
        const target = resolve(await realpath(ancestor), relative(ancestor, this.profile));
        const rel = relative(await realpath(this.packageRoot), target);
        if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
            throw new EmsError("invalid_profile", "The resolved profile must stay outside the bundle directory.");
        await this.lock.acquire();
        try {
            await mkdir(this.profile, { recursive: true, mode: 0o700 });
            this.context = await chromium.launchPersistentContext(this.profile, {
                channel: this.channel,
                headless: !this.headed,
                args: ["--restore-last-session"],
                viewport: { width: 1280, height: 900 },
                acceptDownloads: false,
                timeout: 30_000,
            });
            this.context.setDefaultTimeout(15_000);
            this.context.setDefaultNavigationTimeout(30_000);
            this.currentPage = this.context.pages()[0] || (await this.context.newPage());
            // Session restore is needed for EMS's session cookies. Keep a single
            // controlled page; restored background tabs must not issue concurrent EMS operations.
            for (const page of this.context.pages())
                if (page !== this.currentPage)
                    await page.close({ runBeforeUnload: false });
            this.currentPage.on("dialog", (dialog) => {
                void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => { });
            });
            return this.currentPage;
        }
        catch {
            await this.close();
            throw new EmsError("browser_unavailable", "Could not open the dedicated EMS browser. Install the selected Chrome/Edge channel, or stop another process using this profile.");
        }
    }
    async identity(timeout = 10_000) {
        const page = await this.page();
        // A valid EMS page briefly shows Guest while its account header initializes.
        try {
            await page.waitForFunction((base) => location.href.startsWith(base) &&
                !!document.querySelector("#usernameid")?.textContent?.trim() &&
                !/\bguest\b|^sign in$|^login$/i.test(document.querySelector("#usernameid")?.textContent?.trim() || ""), EMS_BASE, { timeout });
        }
        catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError")
                throw error;
        }
        const url = new URL(page.url());
        const name = await page.locator("#usernameid").textContent({ timeout: 500 }).catch(() => null);
        const signedOut = name && /\bguest\b|^sign in$|^login$/i.test(name.trim());
        const login = /\/(?:login|signin|logon|saml)(?:[./]|$)/i.test(url.pathname);
        if (signedOut || login || url.hostname === "secure.its.yale.edu")
            throw signInRequired();
        if (!url.href.startsWith(EMS_BASE) || !name?.trim())
            throw new EmsError("page_changed", "EMS did not return a recognizable account page.");
        const cookies = (await page.context().cookies(EMS_BASE))
            .filter((c) => c.httpOnly && !/^ARRAffinity/i.test(c.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (!cookies.length)
            throw signInRequired();
        const key = createHash("sha256")
            .update(JSON.stringify([name.trim(), cookies.map((c) => [c.name, c.value])]))
            .digest("hex");
        return { key, name: name.trim() };
    }
    async openHome(timeout = 30_000) {
        const page = await this.page();
        await this.navigate(page, `${EMS_BASE}Default.aspx`, timeout);
        return page;
    }
    async navigate(page, url, timeout = 30_000) {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch((error) => {
            if (error instanceof Error && (error.name === "TimeoutError" || error.message.includes("net::ERR_")))
                throw new EmsError("transport_unavailable", "The EMS connection was interrupted.");
            throw error;
        });
        this.checkNavigation(response);
    }
    checkNavigation(response) {
        const status = response?.status();
        if (status === 401)
            throw signInRequired();
        if (status === 429) {
            const value = response?.headers()["retry-after"] ?? "";
            const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
            throw new EmsError("rate_limited", "EMS is rate limiting requests.", {
                retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : 60_000,
            });
        }
        if (status && status >= 500)
            throw new EmsError("transport_unavailable", "EMS is temporarily unavailable.");
    }
    async accountFingerprint(page) {
        // My Account is a provider-rendered, read-only route. A display name alone cannot bind a renewal.
        const link = page.locator("a").filter({ hasText: /^\s*My Account\s*$/i });
        if ((await link.count()) !== 1)
            return;
        const href = await link.getAttribute("href");
        if (!href || href.startsWith("#"))
            return;
        const url = new URL(href, page.url());
        if (!url.href.startsWith(EMS_BASE) || url.href === page.url())
            return;
        const account = await page.context().newPage();
        try {
            await this.navigate(account, url.href, 8_000);
            if (!account.url().startsWith(EMS_BASE))
                return;
            const field = account.getByLabel(/^\s*(?:e-?mail(?: address)?)[\s:*]*$/i);
            const email = await field.inputValue({ timeout: 2_000 }).catch(() => "");
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
                return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
        }
        finally {
            await account.close().catch(() => { });
        }
    }
    async boundAccount() {
        const value = await readFile(`${this.profile}.account`, "utf8").catch((error) => {
            if (error.code === "ENOENT")
                return "";
            throw error;
        });
        if (value && !/^[a-f0-9]{64}$/.test(value))
            throw new EmsError("identity_mismatch", "The saved EMS account could not be verified. Reconnect EMS.");
        return value || undefined;
    }
    async bindAccount(fingerprint) {
        const file = `${this.profile}.account`;
        if (!fingerprint) {
            await rm(file, { force: true });
            return;
        }
        const temporary = `${file}.${randomUUID()}`;
        try {
            await writeFile(temporary, fingerprint, { mode: 0o600, flag: "wx" });
            await rename(temporary, file);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
    async login(timeoutMs = 1_800_000) {
        const page = await this.openHome();
        const identity = await this.identity(timeoutMs);
        await this.bindAccount(await this.accountFingerprint(page).catch(() => undefined));
        return identity;
    }
    async renew() {
        const expected = await this.boundAccount();
        if (!expected)
            throw signInRequired();
        const page = await this.openHome(12_000);
        if (page.url().startsWith(EMS_BASE)) {
            const signIn = page.getByRole("link", { name: "Sign In", exact: true });
            if (await signIn.count() === 1 && await signIn.isVisible())
                await signIn.click({ timeout: 4_000 });
        }
        const identity = await this.identity(8_000).catch((error) => {
            if (error instanceof EmsError && error.code === "page_changed")
                throw signInRequired();
            throw error;
        });
        const actual = await this.accountFingerprint(page);
        if (!actual)
            throw signInRequired();
        if (actual !== expected)
            throw new EmsError("identity_mismatch", "EMS returned a different account. Reconnect to the original account.");
        return identity;
    }
    async close() {
        this.currentPage = undefined;
        const context = this.context;
        this.context = undefined;
        try {
            await context?.close();
        }
        finally {
            await this.lock.release();
        }
    }
}
export function signInRequired() {
    return new EmsError("auth_required", "Sign in required. Reconnect Yale SOM EMS or run login with the same profile and browser.");
}
