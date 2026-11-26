import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_STATES,
  AUTH_STATUS_STORAGE_KEY,
  createGoogleAuthClient,
  getOAuthConfigStatus,
  READONLY_SHEETS_SCOPE,
} from "../modules/sheets/google-auth.js";

function createMockStorage() {
  const store = new Map();
  return {
    _dump() {
      return Object.fromEntries(store.entries());
    },
    async get(key) {
      return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
  };
}

test("getOAuthConfigStatus detects missing client_id, disallowed write scopes, and valid read-only config", () => {
  const missing = getOAuthConfigStatus({ permissions: ["identity"] });
  assert.equal(missing.configured, false);

  const placeholder = getOAuthConfigStatus({
    oauth2: { client_id: "YOUR_CLIENT_ID.apps.googleusercontent.com", scopes: [READONLY_SHEETS_SCOPE] },
  });
  assert.equal(placeholder.configured, false);

  const writeScope = getOAuthConfigStatus({
    oauth2: {
      client_id: "1234567890-abc.apps.googleusercontent.com",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    },
  });
  assert.equal(writeScope.configured, false);
  assert.equal(writeScope.readOnlyCompliant, false);

  const valid = getOAuthConfigStatus({
    oauth2: {
      client_id: "1234567890-abc.apps.googleusercontent.com",
      scopes: [READONLY_SHEETS_SCOPE],
    },
  });
  assert.equal(valid.configured, true);
  assert.equal(valid.readOnlyCompliant, true);
});

test("OAuth connect/disconnect stores only non-secret status metadata and handles rejection, expiry, and revocation", async () => {
  const storage = createMockStorage();
  let mode = "ok";
  let removedTokens = [];

  const mockIdentity = {
    getAuthToken(_opts, cb) {
      if (mode === "reject") return cb(null);
      if (mode === "revoked") throw new Error("invalid_grant: Token has been expired or revoked.");
      return cb("secret-oauth-token-should-never-be-persisted");
    },
    removeCachedAuthToken({ token }, cb) {
      removedTokens.push(token);
      cb();
    },
  };
  const mockRuntime = {
    getManifest: () => ({
      oauth2: {
        client_id: "9988776655-xyz.apps.googleusercontent.com",
        scopes: [READONLY_SHEETS_SCOPE],
      },
    }),
  };

  const authClient = createGoogleAuthClient({
    identityApi: mockIdentity,
    runtimeApi: mockRuntime,
    storageClient: storage,
  });

  const conn = await authClient.connect();
  assert.equal(conn.ok, true);
  const persistedJson = JSON.stringify(storage._dump());
  assert.equal(persistedJson.includes("secret-oauth-token"), false);
  assert.equal((await storage.get(AUTH_STATUS_STORAGE_KEY))[AUTH_STATUS_STORAGE_KEY].status, AUTH_STATES.CONNECTED);

  await authClient.disconnect();
  assert.ok(removedTokens.includes("secret-oauth-token-should-never-be-persisted"));
  assert.equal((await authClient.getStatus()).status, AUTH_STATES.DISCONNECTED);

  mode = "revoked";
  const revRes = await authClient.connect();
  assert.equal(revRes.ok, false);
  assert.equal(revRes.state, AUTH_STATES.REVOKED);

  // Missing OAuth config handling
  const unconfiguredAuth = createGoogleAuthClient({
    identityApi: mockIdentity,
    runtimeApi: { getManifest: () => ({ permissions: ["identity"] }) },
    storageClient: storage,
  });
  const unconfRes = await unconfiguredAuth.connect();
  assert.equal(unconfRes.ok, false);
  assert.equal(unconfRes.state, AUTH_STATES.UNCONFIGURED);
});

