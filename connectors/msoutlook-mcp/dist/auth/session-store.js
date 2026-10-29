/**
 * Secure session state storage.
 *
 * Stores Playwright session state (localStorage, cookies) and cached tokens
 * in ~/.msoutlook-mcp-server/ (macOS/Linux) or %APPDATA%\msoutlook-mcp-server\ (Windows).
 *
 * Mirrors the storage approach from msteams-mcp:
 * - scryptSync key derivation (hostname:username — machine-specific, memory-hard)
 * - AES-256-GCM encryption at rest
 * - JSON envelope {iv, content, tag, version} for future-proof migration
 * - isEncrypted() check auto-migrates any legacy plaintext files
 */
import { scryptSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
// ─────────────────────────────────────────────────────────────────────────────
// Config directory (platform-aware, mirrors msteams-mcp)
// ─────────────────────────────────────────────────────────────────────────────
function getHomeDirSafe() {
    try {
        return homedir();
    }
    catch {
        return null;
    }
}
function getConfigDir() {
    const home = getHomeDirSafe();
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? (home ? join(home, 'AppData', 'Roaming') : null);
        if (appData)
            return join(appData, 'msoutlook-mcp-server');
    }
    if (home)
        return join(home, '.msoutlook-mcp-server');
    // Fallback: alongside the dist directory
    return join(process.cwd(), 'msoutlook-mcp-server-data');
}
export const CONFIG_DIR = getConfigDir();
const SESSION_STATE_FILE = 'session-state.json';
const TOKEN_CACHE_FILE = 'token-cache.json';
const BROWSER_PROFILE = 'browser-profile';
/** Session considered stale after this many hours (matches msteams-mcp). */
const SESSION_EXPIRY_HOURS = 12;
// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
export function getSessionStatePath() { return join(CONFIG_DIR, SESSION_STATE_FILE); }
export function getTokenCachePath() { return join(CONFIG_DIR, TOKEN_CACHE_FILE); }
export function getBrowserProfileDir() { return join(CONFIG_DIR, BROWSER_PROFILE); }
function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR))
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}
// ─────────────────────────────────────────────────────────────────────────────
// Encryption — AES-256-GCM with scrypt-derived machine key (mirrors msteams-mcp)
// ─────────────────────────────────────────────────────────────────────────────
const SALT = 'msoutlook-mcp-credential-salt-v1';
function deriveKey() {
    let machineId;
    try {
        machineId = `${hostname()}:${userInfo().username}`;
    }
    catch {
        machineId = CONFIG_DIR; // safe fallback
    }
    return scryptSync(machineId, SALT, 32);
}
function encryptJson(plaintext) {
    const key = deriveKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let content = cipher.update(plaintext, 'utf8', 'hex');
    content += cipher.final('hex');
    return { iv: iv.toString('hex'), content, tag: cipher.getAuthTag().toString('hex'), version: 1 };
}
function decryptEnvelope(env) {
    if (env.version !== 1)
        throw new Error(`Unsupported encryption version: ${env.version}`);
    const key = deriveKey();
    const iv = Buffer.from(env.iv, 'hex');
    const tag = Buffer.from(env.tag, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let out = decipher.update(env.content, 'hex', 'utf8');
    out += decipher.final('utf8');
    return out;
}
function isEncryptedEnvelope(v) {
    if (!v || typeof v !== 'object')
        return false;
    const o = v;
    return typeof o.iv === 'string' && typeof o.content === 'string'
        && typeof o.tag === 'string' && o.version === 1;
}
// ─────────────────────────────────────────────────────────────────────────────
// Generic read/write helpers
// ─────────────────────────────────────────────────────────────────────────────
function writeSecure(filePath, data) {
    ensureConfigDir();
    const envelope = encryptJson(JSON.stringify(data));
    writeFileSync(filePath, JSON.stringify(envelope, null, 2), { mode: 0o600, encoding: 'utf8' });
}
function readSecure(filePath) {
    if (!existsSync(filePath))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (isEncryptedEnvelope(parsed)) {
            return JSON.parse(decryptEnvelope(parsed));
        }
        // Legacy plaintext — migrate to encrypted in place
        logger.debug(`Migrating plaintext file to encrypted: ${filePath}`);
        writeSecure(filePath, parsed);
        return parsed;
    }
    catch (err) {
        logger.warn(`Failed to read ${filePath}`, err instanceof Error ? err.message : String(err));
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Session State (Playwright storageState)
// ─────────────────────────────────────────────────────────────────────────────
export function writeSessionState(state) { writeSecure(getSessionStatePath(), state); }
export function readSessionState() { return readSecure(getSessionStatePath()); }
export function hasSessionState() { return existsSync(getSessionStatePath()); }
/** Returns the age of the session state file in hours, or null if it doesn't exist. */
export function getSessionAge() {
    const p = getSessionStatePath();
    if (!existsSync(p))
        return null;
    return (Date.now() - statSync(p).mtimeMs) / (1000 * 60 * 60);
}
/** Returns true if the session state is missing or older than SESSION_EXPIRY_HOURS. */
export function isSessionLikelyExpired() {
    const age = getSessionAge();
    return age === null || age > SESSION_EXPIRY_HOURS;
}
// ─────────────────────────────────────────────────────────────────────────────
// Token Cache
// ─────────────────────────────────────────────────────────────────────────────
export function writeTokenCache(cache) { writeSecure(getTokenCachePath(), cache); }
export function readTokenCache() { return readSecure(getTokenCachePath()); }
export function clearTokenCache() {
    const p = getTokenCachePath();
    if (existsSync(p)) {
        try {
            rmSync(p);
        }
        catch { /* ignore */ }
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Full session clear
// ─────────────────────────────────────────────────────────────────────────────
export function clearSession() {
    if (existsSync(CONFIG_DIR))
        rmSync(CONFIG_DIR, { recursive: true, force: true });
}
//# sourceMappingURL=session-store.js.map