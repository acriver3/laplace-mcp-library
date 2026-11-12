import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cookie, CookieJar } from 'tough-cookie';
import { HOME } from './config.js';

const file = path.join(HOME, 'session.json');
const belongsTo = (cookie, host) => cookie.domain === host
  || (cookie.domain.startsWith('.') && (host === cookie.domain.slice(1) || host.endsWith(cookie.domain)));

export function loadCookies() {
  try {
    const cookies = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cookies.filter((cookie) => typeof cookie?.domain === 'string' &&
      (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
  } catch { return []; }
}

export function saveCookies(cookies) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(cookies), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function canvasCookies(base, cookies, persist = saveCookies) {
  const origin = new URL(base);
  const jar = new CookieJar();
  const otherCookies = [];
  const browserAttributes = new Map();
  const key = (cookie) => JSON.stringify([cookie.name, cookie.domain.replace(/^\./, ''), cookie.path]);
  for (const cookie of cookies) {
    if (!belongsTo(cookie, origin.hostname) || cookie.partitionKey) {
      otherCookies.push(cookie);
      continue;
    }
    browserAttributes.set(key(cookie), cookie.sameSite);
    jar.setCookieSync(new Cookie({
      key: cookie.name,
      value: cookie.value,
      domain: cookie.domain.startsWith('.') ? cookie.domain.slice(1) : undefined,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expires: cookie.expires === -1 ? 'Infinity' : new Date(cookie.expires * 1000),
    }), origin.href, { ignoreError: true });
  }
  return {
    header(url) {
      return new URL(url).origin === origin.origin ? jar.getCookieStringSync(url) : '';
    },
    update(url, headers) {
      const values = headers.getSetCookie?.() ?? [];
      if (!values.length || new URL(url).origin !== origin.origin) return;
      let updated = false;
      for (const value of values) {
        if (/(?:^|;)\s*Partitioned\s*(?:;|$)/i.test(value)) continue;
        const cookie = jar.setCookieSync(value, url, { ignoreError: true });
        if (!cookie) continue;
        updated = true;
        browserAttributes.set(key({ name: cookie.key, domain: cookie.domain, path: cookie.path }),
          cookie.sameSite ? cookie.sameSite[0].toUpperCase() + cookie.sameSite.slice(1) : undefined);
      }
      if (!updated) return;
      const current = jar.serializeSync().cookies
        .map((entry) => Cookie.fromJSON(entry))
        .filter((cookie) => cookie.expiryTime() > Date.now())
        .map((cookie) => {
          const result = {
            name: cookie.key,
            value: cookie.value,
            domain: (cookie.hostOnly ? '' : '.') + cookie.domain,
            path: cookie.path,
            expires: Number.isFinite(cookie.expiryTime()) ? cookie.expiryTime() / 1000 : -1,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
          };
          return { ...result, sameSite: browserAttributes.get(key(result)) ?? 'Lax' };
        });
      persist([...otherCookies, ...current]);
    },
  };
}
