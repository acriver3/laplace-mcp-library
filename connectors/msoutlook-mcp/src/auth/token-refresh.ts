/**
 * HTTP-based token refresh.
 *
 * Uses the OWA first-party client ID (public SPA — no client secret needed) to
 * exchange a cached refresh token for new access tokens via the standard
 * OAuth2 token endpoint.
 *
 * Key detail (from msteams-mcp): the Origin header is REQUIRED for SPA
 * client IDs. Azure AD validates that refresh token grants from SPA clients
 * include a cross-origin Origin header matching a registered redirect URI.
 * Without it Azure AD returns AADSTS9002327.
 */

import { logger } from '../utils/logger.js';
import { OWA_CLIENT_ID, OWA_SCOPE, GRAPH_SCOPE, OWA_BASE } from '../constants.js';
import { readTokenCache, writeTokenCache, type TokenCache } from './session-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent refresh guards — separate per resource so an OWA refresh doesn't
// block a Graph refresh (mirrors msteams-mcp's guard, split by scope).
// ─────────────────────────────────────────────────────────────────────────────

let owaRefreshInProgress = false;
let graphRefreshInProgress = false;
const recoveryEnabled = () => process.env.LAPLACE_SESSION_RECOVERY_V1 === 'true';
export class TokenRefreshError extends Error {
  constructor(readonly code: 'invalid_grant' | 'transport_unavailable' | 'rate_limited' | 'refresh_failed', readonly retryAfterMs = 0) {
    super(code === 'invalid_grant' ? 'Session revoked or expired. Sign in again.' : 'Token refresh unavailable. Retry later; existing credentials were retained.');
  }
}
const accountQueues = new Map<string, Promise<unknown>>();
const pendingRefreshes = new Map<string, Promise<string | null>>();
function serializedRefresh(resource: 'owa' | 'graph'): Promise<string | null> {
  const initial = readTokenCache();
  if (!initial?.refreshToken || !initial.tenantId) return Promise.resolve(null);
  const account = JSON.stringify([initial.tenantId, initial.upn ?? '']);
  const key = account + ':' + resource;
  const pending = pendingRefreshes.get(key);
  if (pending) return pending;
  const task = (accountQueues.get(account) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const cache = readTokenCache();
    if (!cache || JSON.stringify([cache.tenantId, cache.upn ?? '']) !== account) throw new TokenRefreshError('refresh_failed');
    const response = await callTokenEndpoint(cache.tenantId!, cache.refreshToken, resource === 'owa' ? OWA_SCOPE : GRAPH_SCOPE);
    if (!response) return null;
    const current = readTokenCache();
    if (!current || current.refreshToken !== cache.refreshToken || current.tenantId !== cache.tenantId || current.upn !== cache.upn)
      throw new TokenRefreshError('refresh_failed');
    writeTokenCache({ ...current,
      ...(resource === 'owa' ? { owaToken: response.access_token, owaTokenExpiry: Date.now() + response.expires_in * 1000 }
        : { graphToken: response.access_token, graphTokenExpiry: Date.now() + response.expires_in * 1000 }),
      refreshToken: response.refresh_token ?? current.refreshToken, extractedAt: Date.now() });
    return response.access_token;
  });
  accountQueues.set(account, task);
  pendingRefreshes.set(key, task);
  const cleanup = () => {
    if (pendingRefreshes.get(key) === task) pendingRefreshes.delete(key);
    if (accountQueues.get(account) === task) accountQueues.delete(account);
  };
  void task.then(cleanup, cleanup);
  return task;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core HTTP call
// ─────────────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

const REFRESH_TIMEOUT_MS = 10_000;

async function callTokenEndpoint(
  tenantId: string,
  refreshToken: string,
  scope: string,
): Promise<TokenResponse | null> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: OWA_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Required for SPA public clients — Azure AD returns AADSTS9002327 without this
        'Origin': OWA_BASE,
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      if (recoveryEnabled()) {
        const error = await res.json().catch(() => ({})) as { error?: string };
        const retry = res.headers?.get('retry-after');
        const ms = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
        throw new TokenRefreshError(error.error === 'invalid_grant' ? 'invalid_grant' : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'transport_unavailable' : 'refresh_failed', Number.isFinite(ms) ? Math.max(0, ms) : 0);
      }
      const text = await res.text().catch(() => '');
      logger.warn(`Token refresh HTTP ${res.status}`, text.slice(0, 200));
      return null;
    }

    const result = await res.json() as TokenResponse;
    if (recoveryEnabled() && (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token)))) throw new TokenRefreshError('refresh_failed');
    return result;
  } catch (err) {
    if (recoveryEnabled()) throw err instanceof TokenRefreshError ? err : new TokenRefreshError('transport_unavailable');
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn('Token refresh request timed out');
    } else {
      logger.warn('Token refresh network error', err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public refresh functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh the OWA access token via HTTP.
 * Returns the new access token on success, null on failure.
 * Prevents concurrent refresh races with module-level guard.
 */
export async function refreshOwaToken(): Promise<string | null> {
  if (recoveryEnabled()) return serializedRefresh('owa');
  if (owaRefreshInProgress) {
    logger.debug('OWA token refresh already in progress');
    return null;
  }

  const cache = readTokenCache();
  if (!cache?.refreshToken || !cache.tenantId) {
    logger.debug('No refresh token or tenant ID cached');
    return null;
  }

  owaRefreshInProgress = true;
  try {
    logger.debug('Refreshing OWA access token via HTTP');
    const response = await callTokenEndpoint(cache.tenantId, cache.refreshToken, OWA_SCOPE);
    if (!response) return null;

    const updated: TokenCache = {
      ...cache,
      owaToken: response.access_token,
      owaTokenExpiry: Date.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token ?? cache.refreshToken,
      extractedAt: Date.now(),
    };
    writeTokenCache(updated);
    logger.info('OWA token refreshed successfully');
    return response.access_token;
  } finally {
    owaRefreshInProgress = false;
  }
}

/**
 * Refresh the Graph access token via HTTP.
 */
export async function refreshGraphToken(): Promise<string | null> {
  if (recoveryEnabled()) return serializedRefresh('graph');
  if (graphRefreshInProgress) return null;

  const cache = readTokenCache();
  if (!cache?.refreshToken || !cache.tenantId) return null;

  graphRefreshInProgress = true;
  try {
    logger.debug('Refreshing Graph access token via HTTP');
    const response = await callTokenEndpoint(cache.tenantId, cache.refreshToken, GRAPH_SCOPE);
    if (!response) return null;

    const updated: TokenCache = {
      ...cache,
      graphToken: response.access_token,
      graphTokenExpiry: Date.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token ?? cache.refreshToken,
      extractedAt: Date.now(),
    };
    writeTokenCache(updated);
    logger.info('Graph token refreshed successfully');
    return response.access_token;
  } finally {
    graphRefreshInProgress = false;
  }
}
