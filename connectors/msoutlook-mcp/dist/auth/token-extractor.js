/**
 * Extract MSAL tokens from Outlook Web App's localStorage.
 *
 * OWA uses MSAL and stores access tokens, refresh tokens, and ID tokens
 * in localStorage under keys like:
 *   msal.3|{accountId}|login.windows.net|accesstoken|{clientId}|{tenantId}|{scopes}
 *   msal.3|{accountId}|login.windows.net|refreshtoken|{clientId}|||
 *
 * MSAL browser v4+ may encrypt these values ({id, nonce, data}) unless KMSI
 * was selected. Pass Playwright cookies so encrypted entries can be decrypted.
 */
import { logger } from '../utils/logger.js';
import { OWA_CLIENT_ID } from '../constants.js';
import { resolveMsalLocalStorage } from './msal-decrypt.js';
// ─────────────────────────────────────────────────────────────────────────────
// JWT utilities
// ─────────────────────────────────────────────────────────────────────────────
function decodeJwtPayload(token) {
    try {
        const parts = token.split('.');
        if (parts.length < 2)
            return null;
        // Handle base64url encoding
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    }
    catch {
        return null;
    }
}
function getJwtExpiry(token) {
    const payload = decodeJwtPayload(token);
    if (!payload?.exp || typeof payload.exp !== 'number')
        return null;
    return new Date(payload.exp * 1000);
}
function isJwt(value) {
    return typeof value === 'string' && value.startsWith('ey');
}
// ─────────────────────────────────────────────────────────────────────────────
// Extraction from Playwright storageState localStorage entries
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Extract all MSAL tokens from the Playwright storageState localStorage array.
 *
 * @param localStorage Array of {name, value} entries from Playwright storageState
 * @param cookies Playwright cookies (needed to decrypt MSAL v4 encrypted cache)
 */
export async function extractTokensFromLocalStorage(localStorage, cookies) {
    const resolved = await resolveMsalLocalStorage(localStorage, cookies);
    let bestOwaToken = null;
    let bestGraphToken = null;
    let refreshToken = null;
    let tenantId;
    let upn;
    for (const item of resolved) {
        const key = item.name;
        if (!key.startsWith('msal.'))
            continue;
        let entry;
        try {
            entry = JSON.parse(item.value);
        }
        catch {
            continue;
        }
        if (!entry.secret)
            continue;
        // ── Refresh Token ─────────────────────────────────────────────────────
        if (key.includes('refreshtoken') && entry.clientId === OWA_CLIENT_ID) {
            refreshToken = entry.secret;
            continue;
        }
        // ── Access Tokens ─────────────────────────────────────────────────────
        if (!key.includes('accesstoken'))
            continue;
        const isOwaToken = entry.target?.includes('outlook.office.com') ?? false;
        let expiry = isJwt(entry.secret) ? getJwtExpiry(entry.secret) : null;
        if (!expiry && isOwaToken) {
            const expiresOn = Number(entry.expiresOn);
            if (Number.isFinite(expiresOn) && expiresOn > 0)
                expiry = new Date(expiresOn * 1000);
        }
        if (!expiry)
            continue;
        if (expiry.getTime() <= Date.now())
            continue; // skip expired
        // Extract UPN and tenant from any token
        if (!upn) {
            const payload = decodeJwtPayload(entry.secret);
            if (payload) {
                upn = payload.upn ?? payload.preferred_username;
                tenantId = tenantId ?? payload.tid;
            }
        }
        // OWA token — scope contains outlook.office.com
        if (isOwaToken) {
            if (!bestOwaToken || expiry > bestOwaToken.expiry) {
                bestOwaToken = { token: entry.secret, expiry };
            }
        }
        // Graph token — scope contains graph.microsoft.com
        if (entry.target?.includes('graph.microsoft.com')) {
            if (!bestGraphToken || expiry > bestGraphToken.expiry) {
                bestGraphToken = { token: entry.secret, expiry };
            }
        }
    }
    if (!bestOwaToken || !refreshToken) {
        logger.debug('Token extraction failed', {
            hasOwaToken: !!bestOwaToken,
            hasRefreshToken: !!refreshToken,
        });
        return null;
    }
    return {
        owaToken: bestOwaToken.token,
        owaTokenExpiry: bestOwaToken.expiry,
        graphToken: bestGraphToken?.token,
        graphTokenExpiry: bestGraphToken?.expiry,
        refreshToken,
        tenantId,
        upn,
    };
}
/**
 * Hostnames that may hold OWA MSAL localStorage.
 * Prefer the unified cloud.microsoft app host; keep legacy office.com / office365.com
 * for sessions that have not redirected yet (MC950871 / Microsoft 365 endpoint list).
 */
const OWA_STORAGE_HOSTS = [
    'outlook.cloud.microsoft',
    'outlook.office.com',
    'outlook.office365.com',
];
/**
 * Get the localStorage array from a Playwright storageState for the OWA origin.
 */
export function getOwaLocalStorage(state) {
    const origins = state.origins;
    if (!origins?.length)
        return null;
    for (const host of OWA_STORAGE_HOSTS) {
        const match = origins.find(o => o.origin.includes(host));
        if (match)
            return match.localStorage;
    }
    return null;
}
//# sourceMappingURL=token-extractor.js.map