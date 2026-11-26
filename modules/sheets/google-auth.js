/**
 * Chrome Identity API (OAuth 2.0) wrapper for strictly read-only Google Sheets access.
 * Never persists access tokens or secrets in storage, IndexedDB, client records, logs, or exports.
 */

export const READONLY_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export const AUTH_STATES = Object.freeze({
  UNCONFIGURED: "OAuth not configured",
  DISCONNECTED: "Disconnected",
  CONNECTED: "Connected",
  EXPIRED: "Token expired",
  REVOKED: "Authorization revoked",
  ERROR: "Authentication error",
});

export const AUTH_STATUS_STORAGE_KEY = "dm_google_auth_metadata";

function isPlaceholderClientId(clientId) {
  const clean = String(clientId || "").trim();
  if (!clean) return true;
  return /your[_-]?client|placeholder|example|replace[_-]?me/i.test(clean);
}

/**
 * Inspect manifest oauth2 settings without mutating or leaking credentials.
 */
export function getOAuthConfigStatus(manifest) {
  const oauth2 = manifest?.oauth2;
  const clientId = String(oauth2?.client_id || "").trim();
  const scopes = Array.isArray(oauth2?.scopes) ? oauth2.scopes : [];

  if (!oauth2 || isPlaceholderClientId(clientId)) {
    return {
      configured: false,
      clientIdConfigured: false,
      readOnlyCompliant: true,
      scopes,
      error: "Google OAuth Client ID is not configured in manifest.json (see docs/GOOGLE_CLOUD_SETUP.md).",
    };
  }

  const disallowed = scopes.filter((s) => s !== READONLY_SHEETS_SCOPE);
  if (disallowed.length > 0) {
    return {
      configured: false,
      clientIdConfigured: true,
      readOnlyCompliant: false,
      scopes,
      error: `Disallowed non-readonly OAuth scopes in manifest.json: ${disallowed.join(", ")}`,
    };
  }

  if (!scopes.includes(READONLY_SHEETS_SCOPE)) {
    return {
      configured: false,
      clientIdConfigured: true,
      readOnlyCompliant: false,
      scopes,
      error: `Manifest oauth2.scopes must include '${READONLY_SHEETS_SCOPE}'.`,
    };
  }

  return {
    configured: true,
    clientIdConfigured: true,
    readOnlyCompliant: true,
    scopes,
    scopeNotice:
      "Read-only scope grants read access to Google Sheets accessible to the signed-in Google account, not only the currently selected worksheet.",
  };
}

export function classifyOAuthError(error) {
  const msg = String(error?.message || error || "").trim();
  const lower = msg.toLowerCase();

  if (!msg) {
    return { state: AUTH_STATES.ERROR, code: "UNKNOWN_AUTH_ERROR", message: "Unknown Google OAuth error." };
  }
  if (lower.includes("did not approve") || lower.includes("canceled") || lower.includes("cancelled") || lower.includes("access_denied")) {
    return { state: AUTH_STATES.DISCONNECTED, code: "USER_REJECTED", message: "Google account permission request was cancelled or denied by the user." };
  }
  if (lower.includes("bad client id") || lower.includes("oauth2 not granted") || lower.includes("client_id")) {
    return { state: AUTH_STATES.UNCONFIGURED, code: "INVALID_OAUTH_CONFIG", message: "Google OAuth Client ID is invalid or missing for this extension ID." };
  }
  if (lower.includes("invalid_grant") || lower.includes("revoked") || lower.includes("token has been expired or revoked")) {
    return { state: AUTH_STATES.REVOKED, code: "TOKEN_REVOKED", message: "Google authorization was revoked or expired. Reconnect your Google account." };
  }
  if (lower.includes("network") || lower.includes("failed to fetch")) {
    return { state: AUTH_STATES.ERROR, code: "NETWORK_ERROR", message: "Network error while contacting Google authentication servers." };
  }
  return { state: AUTH_STATES.ERROR, code: "AUTH_FAILED", message: msg };
}

function callIdentityGetAuthToken(identityApi, options) {
  if (!identityApi || typeof identityApi.getAuthToken !== "function") {
    return Promise.reject(new Error("chrome.identity API is unavailable."));
  }
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = identityApi.getAuthToken(options, (res) => {
        const lastErr = globalThis.chrome?.runtime?.lastError;
        if (lastErr) {
          reject(new Error(lastErr.message || String(lastErr)));
          return;
        }
        const token = typeof res === "string" ? res : res?.token;
        resolve(token || null);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then((res) => {
          const token = typeof res === "string" ? res : res?.token;
          resolve(token || null);
        }, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

function callIdentityRemoveCachedToken(identityApi, token) {
  if (!identityApi || typeof identityApi.removeCachedAuthToken !== "function" || !token) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const maybePromise = identityApi.removeCachedAuthToken({ token }, () => resolve());
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(() => resolve(), () => resolve());
      }
    } catch {
      resolve();
    }
  });
}

export function createGoogleAuthClient({
  identityApi = globalThis.chrome?.identity,
  runtimeApi = globalThis.chrome?.runtime,
  storageClient,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  async function loadMeta() {
    if (!storageClient) return {};
    const res = await storageClient.get(AUTH_STATUS_STORAGE_KEY);
    return res?.[AUTH_STATUS_STORAGE_KEY] || {};
  }

  async function saveMeta(patch) {
    if (!storageClient) return;
    const prev = await loadMeta();
    const { accessToken: _d1, token: _d2, ...safePatch } = patch || {};
    await storageClient.set({
      [AUTH_STATUS_STORAGE_KEY]: {
        ...prev,
        ...safePatch,
      },
    });
  }

  async function getStatus() {
    const manifest = runtimeApi?.getManifest ? runtimeApi.getManifest() : null;
    const oauthConfig = getOAuthConfigStatus(manifest);
    const meta = await loadMeta();

    let status = meta.status || AUTH_STATES.DISCONNECTED;
    if (!oauthConfig.configured) {
      status = AUTH_STATES.UNCONFIGURED;
    }

    return {
      ok: true,
      status,
      oauthConfigured: oauthConfig.configured,
      oauthError: oauthConfig.error || null,
      scope: READONLY_SHEETS_SCOPE,
      scopeNotice: oauthConfig.scopeNotice || null,
      lastConnectedAt: meta.lastConnectedAt || null,
      lastTestedAt: meta.lastTestedAt || null,
      lastError: oauthConfig.configured ? meta.lastError || null : oauthConfig.error,
    };
  }

  async function getValidToken({ interactive = false, forceRefresh = false } = {}) {
    const manifest = runtimeApi?.getManifest ? runtimeApi.getManifest() : null;
    const oauthConfig = getOAuthConfigStatus(manifest);
    if (!oauthConfig.configured) {
      await saveMeta({ status: AUTH_STATES.UNCONFIGURED, lastError: oauthConfig.error });
      return { ok: false, state: AUTH_STATES.UNCONFIGURED, error: oauthConfig.error };
    }

    if (forceRefresh) {
      try {
        const staleToken = await callIdentityGetAuthToken(identityApi, {
          interactive: false,
          scopes: [READONLY_SHEETS_SCOPE],
        });
        if (staleToken) {
          await callIdentityRemoveCachedToken(identityApi, staleToken);
        }
      } catch {
        // Proceed to fresh token request.
      }
    }

    try {
      const token = await callIdentityGetAuthToken(identityApi, {
        interactive: Boolean(interactive),
        scopes: [READONLY_SHEETS_SCOPE],
      });
      if (!token) {
        const msg = "No OAuth access token returned by Chrome Identity API.";
        await saveMeta({ status: AUTH_STATES.DISCONNECTED, lastError: msg });
        return { ok: false, state: AUTH_STATES.DISCONNECTED, error: msg };
      }
      await saveMeta({
        status: AUTH_STATES.CONNECTED,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
      });
      return { ok: true, token };
    } catch (error) {
      const classified = classifyOAuthError(error);
      await saveMeta({ status: classified.state, lastError: classified.message });
      return { ok: false, state: classified.state, code: classified.code, error: classified.message };
    }
  }

  async function connect() {
    return getValidToken({ interactive: true, forceRefresh: false });
  }

  async function disconnect() {
    try {
      const existing = await callIdentityGetAuthToken(identityApi, {
        interactive: false,
        scopes: [READONLY_SHEETS_SCOPE],
      });
      if (existing) {
        await callIdentityRemoveCachedToken(identityApi, existing);
      }
    } catch {
      // Safe best-effort token cache clearing.
    }
    await saveMeta({
      status: AUTH_STATES.DISCONNECTED,
      lastError: null,
    });
    return { ok: true, status: AUTH_STATES.DISCONNECTED };
  }

  async function markTokenExpired(reason = "Access token expired or rejected (HTTP 401).") {
    await saveMeta({ status: AUTH_STATES.EXPIRED, lastError: reason });
  }

  async function markAuthRevoked(reason = "Google authorization revoked.") {
    await saveMeta({ status: AUTH_STATES.REVOKED, lastError: reason });
  }

  async function testConnection({ spreadsheetId = "" } = {}) {
    const tokRes = await getValidToken({ interactive: false, forceRefresh: false });
    if (!tokRes.ok) {
      return tokRes;
    }

    if (!spreadsheetId) {
      await saveMeta({ status: AUTH_STATES.CONNECTED, lastTestedAt: new Date().toISOString(), lastError: null });
      return { ok: true, status: AUTH_STATES.CONNECTED, message: "OAuth token is active and valid." };
    }

    if (!fetchImpl) {
      return { ok: false, status: AUTH_STATES.ERROR, error: "Fetch API unavailable for connection test." };
    }

    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties(title,locale,timeZone)`;
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokRes.token}` },
      });
      if (res.ok) {
        const meta = await res.json();
        await saveMeta({
          status: AUTH_STATES.CONNECTED,
          lastTestedAt: new Date().toISOString(),
          lastError: null,
        });
        return {
          ok: true,
          status: AUTH_STATES.CONNECTED,
          spreadsheetId: meta.spreadsheetId,
          spreadsheetTitle: meta.properties?.title || "",
        };
      }
      const errText = await res.text().catch(() => "");
      const statusMsg =
        res.status === 401
          ? "Token expired or invalid (HTTP 401)."
          : res.status === 403
            ? "Permission denied or Google Sheets API not enabled (HTTP 403)."
            : res.status === 404
              ? "Spreadsheet not found or inaccessible for the connected Google account (HTTP 404)."
              : `Google Sheets API error (HTTP ${res.status}): ${errText}`;
      const nextState = res.status === 401 ? AUTH_STATES.EXPIRED : AUTH_STATES.ERROR;
      await saveMeta({ status: nextState, lastError: statusMsg });
      return { ok: false, status: nextState, httpStatus: res.status, error: statusMsg };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await saveMeta({ status: AUTH_STATES.ERROR, lastError: msg });
      return { ok: false, status: AUTH_STATES.ERROR, error: msg };
    }
  }

  return {
    getStatus,
    getValidToken,
    connect,
    disconnect,
    testConnection,
    markTokenExpired,
    markAuthRevoked,
  };
}

