import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, BrowserContext, Page } from "playwright-core";

import { EMS_BASE, EmsError } from "./types.js";

export const DEFAULT_PROFILE = resolve(homedir(), ".laplace-local/sessions/yale-som-ems/profile");
export class ProfileLock {
	private token = randomUUID();
	private acquired = false;
	readonly file: string;
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
				throw new EmsError(
					"profile_busy",
					"Another process owns this EMS profile, or it did not shut down cleanly. Stop it first; status --release-stale-lock can release a dead owner.",
				);
			throw error;
		}
		try {
			await file.writeFile(
				JSON.stringify({ pid: process.pid, platform: process.platform, token: this.token }),
			);
			this.acquired = true;
		} finally {
			await file.close();
		}
	}
	async release() {
		if (!this.acquired) return;
		const owner = JSON.parse(await readFile(this.file, "utf8").catch(() => "{}"));
		if (owner.token === this.token) await unlink(this.file);
		this.acquired = false;
	}
	async releaseStale() {
		const owner = JSON.parse(await readFile(this.file, "utf8").catch(() => "{}"));
		if (!owner.pid || owner.platform !== process.platform)
			throw new EmsError(
				"profile_busy",
				"Cannot verify the profile owner. Inspect the lock locally.",
			);
		try {
			process.kill(owner.pid, 0);
			throw new EmsError("profile_busy", "The profile owner is still running.");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
		await unlink(this.file);
	}
}
export class EmsBrowser {
	readonly profile: string;
	readonly lock: ProfileLock;
	private context?: BrowserContext;
	private currentPage?: Page;
	private packageRoot: string;
	constructor(
		profile = DEFAULT_PROFILE,
		readonly channel: "chrome" | "msedge" = "chrome",
		readonly headed = false,
	) {
		this.profile = resolve(profile);
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		this.packageRoot = packageRoot;
		const rel = relative(packageRoot, this.profile);
		if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
			throw new EmsError(
				"invalid_profile",
				"Choose a dedicated profile outside the bundle directory.",
			);
		if (this.profile === homedir() || this.profile === resolve("/"))
			throw new EmsError("invalid_profile", "Choose a dedicated EMS profile directory.");
		this.lock = new ProfileLock(this.profile);
	}
	async page(): Promise<Page> {
		if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
		// Resolve existing ancestors before creating a profile or its lock. A symlink
		// must not put sessions back inside the bundle's archive boundary.
		let ancestor = this.profile;
		while (true) {
			try {
				await realpath(ancestor);
				break;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw e;
				ancestor = parent;
			}
		}
		const target = resolve(await realpath(ancestor), relative(ancestor, this.profile));
		const rel = relative(await realpath(this.packageRoot), target);
		if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
			throw new EmsError(
				"invalid_profile",
				"The resolved profile must stay outside the bundle directory.",
			);
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
				if (page !== this.currentPage) await page.close({ runBeforeUnload: false });
			this.currentPage.on("dialog", (dialog) => {
				void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(
					() => {},
				);
			});
			return this.currentPage;
		} catch {
			await this.close();
			throw new EmsError(
				"browser_unavailable",
				"Could not open the dedicated EMS browser. Install the selected Chrome/Edge channel, or stop another process using this profile.",
			);
		}
	}
	async identity() {
		const page = await this.page();
		// EMS renders a Guest header before its asynchronous account bootstrap.
		// Wait for that bootstrap rather than rejecting a valid saved session.
		await page
			.waitForFunction(
				(base) =>
					location.href.startsWith(base) &&
					!!document.querySelector("#usernameid")?.textContent?.trim() &&
					!/guest|sign in|login/i.test(document.querySelector("#usernameid")?.textContent || ""),
				EMS_BASE,
				{ timeout: 10_000 },
			)
			.catch(() => {});
		const name = await page
			.locator("#usernameid")
			.textContent()
			.catch(() => null);
		if (!page.url().startsWith(EMS_BASE) || !name?.trim() || /guest|sign in|login/i.test(name))
			throw new EmsError(
				"auth_required",
				"Run the bundled CLI login command with this same profile and browser, and complete Yale SSO/MFA.",
			);
		const cookies = (await page.context().cookies(EMS_BASE))
			.filter((c) => c.httpOnly && !/^ARRAffinity/i.test(c.name))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (!cookies.length)
			throw new EmsError(
				"auth_required",
				"No authenticated EMS session is available. Run login again.",
			);
		const key = createHash("sha256")
			.update(JSON.stringify([name.trim(), cookies.map((c) => [c.name, c.value])]))
			.digest("hex");
		return { key, name: name.trim() };
	}
	async login(timeoutMs = 1_800_000) {
		const page = await this.page();
		await page.goto(`${EMS_BASE}Default.aspx`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(
			(base) =>
				location.href.startsWith(base) &&
				!!document.querySelector("#usernameid")?.textContent?.trim() &&
				!/guest|sign in|login/i.test(document.querySelector("#usernameid")?.textContent || ""),
			EMS_BASE,
			{ timeout: timeoutMs },
		);
		return this.identity();
	}
	async close() {
		this.currentPage = undefined;
		const context = this.context;
		this.context = undefined;
		try {
			await context?.close();
		} finally {
			await this.lock.release();
		}
	}
}
