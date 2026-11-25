/**
 * Thin promise-friendly wrapper around chrome.storage.local with testability support.
 */
export const STORAGE_KEYS = Object.freeze({
  EXTENSION_META: "dm_extension_meta",
  HEALTH_CHECK: "dm_health_check",
});

export function createStorageClient(storageArea = globalThis.chrome?.storage?.local) {
  if (!storageArea) {
    throw new Error("chrome.storage.local is unavailable in this context.");
  }

  return {
    async get(keys) {
      return storageArea.get(keys);
    },

    async set(items) {
      return storageArea.set(items);
    },

    async remove(keys) {
      return storageArea.remove(keys);
    },

    async pingStorage() {
      const checkedAt = new Date().toISOString();
      const probe = { ok: true, checkedAt };
      await storageArea.set({ [STORAGE_KEYS.HEALTH_CHECK]: probe });
      const result = await storageArea.get(STORAGE_KEYS.HEALTH_CHECK);
      const saved = result?.[STORAGE_KEYS.HEALTH_CHECK];
      return {
        ok: Boolean(saved?.ok && saved?.checkedAt === checkedAt),
        checkedAt,
      };
    },
  };
}

