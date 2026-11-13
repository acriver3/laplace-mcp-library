import { chromium } from "playwright-core";

import { CmsBrowser, DEFAULT_CDP_URL, DEFAULT_DOWNLOADS } from "../../dist/browser.js";
import { TIMEZONE } from "../../dist/types.js";

/** Offline browser fixtures only. Production CmsBrowser never launches Chrome. */
export class FixtureCmsBrowser extends CmsBrowser {
  constructor(
    stateDir,
    legacyChannel = DEFAULT_CDP_URL,
    interactiveLogin = false,
    downloadsDir = DEFAULT_DOWNLOADS,
  ) {
    super(
      stateDir,
      ["chrome", "msedge"].includes(legacyChannel) ? DEFAULT_CDP_URL : legacyChannel,
      interactiveLogin,
      downloadsDir,
    );
  }
  async connectOwnedPage() {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({
      timezoneId: TIMEZONE,
      serviceWorkers: "block",
      acceptDownloads: true,
    });
    await context.addCookies([
      {
        name: ".ASPXAUTH.Shared",
        value: "sanitized-fixture-auth",
        domain: "som-yale.12twenty.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ]);
    const page = await context.newPage();
    return { page, close: () => browser.close() };
  }
}
