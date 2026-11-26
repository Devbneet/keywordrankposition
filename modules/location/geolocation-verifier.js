/**
 * Verify navigator.geolocation inside the dedicated tab using Runtime.evaluate.
 */

import { LOCATION_STATES } from "./location-state.js";

export const DEFAULT_COORDINATE_TOLERANCE_DEGREES = 0.0001;

export const BROWSER_GPS_LIMITATION_NOTE =
  "Browser GPS verification confirms navigator.geolocation only. It does NOT guarantee Google Search uses these coordinates (Google may use IP address, account, or other signals).";

/**
 * Validate raw reported coordinates from navigator.geolocation.
 * Rejects null, blank strings, non-numbers, NaN, Infinity, or out-of-range coordinates.
 */
export function validateReportedCoords(probe) {
  if (!probe || typeof probe !== "object") {
    return { valid: false, error: "Empty response from browser geolocation probe." };
  }

  const { latitude, longitude, accuracy } = probe;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { valid: false, error: `Invalid or missing reported latitude: ${String(latitude)}` };
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { valid: false, error: `Invalid or missing reported longitude: ${String(longitude)}` };
  }
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy <= 0) {
    return { valid: false, error: `Invalid or missing reported accuracy: ${String(accuracy)}` };
  }

  return {
    valid: true,
    coords: { latitude, longitude, accuracy },
  };
}

/**
 * Compare expected coordinates against reported coordinates within tolerance.
 */
export function compareCoordinates({
  expectedLatitude,
  expectedLongitude,
  reportedLatitude,
  reportedLongitude,
  toleranceDegrees = DEFAULT_COORDINATE_TOLERANCE_DEGREES,
}) {
  const latitudeDelta = Math.abs(Number(expectedLatitude) - Number(reportedLatitude));
  const longitudeDelta = Math.abs(Number(expectedLongitude) - Number(reportedLongitude));
  const matches =
    Number.isFinite(latitudeDelta) &&
    Number.isFinite(longitudeDelta) &&
    latitudeDelta <= toleranceDegrees &&
    longitudeDelta <= toleranceDegrees;

  return { matches, latitudeDelta, longitudeDelta };
}

function buildGeolocationProbeExpression(timeoutMs) {
  return `(async () => {
    let permissionStatus = "unknown";
    if (navigator.permissions && typeof navigator.permissions.query === "function") {
      try {
        const perm = await navigator.permissions.query({ name: "geolocation" });
        permissionStatus = perm.state;
      } catch (_err) {
        permissionStatus = "unknown";
      }
    }
    if (!navigator.geolocation) {
      return {
        ok: false,
        code: "UNSUPPORTED",
        permissionStatus,
        error: "navigator.geolocation is unavailable in this page."
      };
    }
    return await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          ok: true,
          permissionStatus: permissionStatus === "prompt" ? "granted" : permissionStatus,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        (err) => resolve({
          ok: false,
          code: err.code === 1 ? "PERMISSION_DENIED" : "POSITION_ERROR",
          permissionStatus: err.code === 1 ? "denied" : permissionStatus,
          error: err.message || "Geolocation lookup failed."
        }),
        { enableHighAccuracy: true, timeout: ${Math.max(1000, Number(timeoutMs) || 10000)}, maximumAge: 0 }
      );
    });
  })()`;
}

/**
 * Execute navigator.geolocation check in the attached debugger tab and classify state.
 */
export async function verifyBrowserGeolocation({
  tabId,
  expectedLatitude,
  expectedLongitude,
  toleranceDegrees = DEFAULT_COORDINATE_TOLERANCE_DEGREES,
  chromeApi = globalThis.chrome,
  timeoutMs = 10000,
}) {
  const checkedAt = new Date().toISOString();

  let evalResponse;
  try {
    evalResponse = await chromeApi.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: buildGeolocationProbeExpression(timeoutMs),
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const detached = /detach|target closed|no tab|not attached/i.test(msg);
    return {
      state: detached ? LOCATION_STATES.DEBUGGER_DISCONNECTED : LOCATION_STATES.VERIFICATION_FAILED,
      permissionStatus: "unknown",
      reportedCoords: null,
      latitudeDelta: null,
      longitudeDelta: null,
      lastVerifiedAt: checkedAt,
      lastError: msg,
      limitationNote: BROWSER_GPS_LIMITATION_NOTE,
    };
  }

  if (evalResponse?.exceptionDetails) {
    return {
      state: LOCATION_STATES.VERIFICATION_FAILED,
      permissionStatus: "unknown",
      reportedCoords: null,
      latitudeDelta: null,
      longitudeDelta: null,
      lastVerifiedAt: checkedAt,
      lastError: evalResponse.exceptionDetails.text || "Runtime.evaluate threw an exception.",
      limitationNote: BROWSER_GPS_LIMITATION_NOTE,
    };
  }

  const probe = evalResponse?.result?.value;
  if (!probe) {
    return {
      state: LOCATION_STATES.VERIFICATION_FAILED,
      permissionStatus: "unknown",
      reportedCoords: null,
      latitudeDelta: null,
      longitudeDelta: null,
      lastVerifiedAt: checkedAt,
      lastError: "Empty response from browser geolocation probe.",
      limitationNote: BROWSER_GPS_LIMITATION_NOTE,
    };
  }

  if (!probe.ok) {
    const denied = probe.code === "PERMISSION_DENIED" || probe.permissionStatus === "denied";
    return {
      state: denied ? LOCATION_STATES.PERMISSION_DENIED : LOCATION_STATES.VERIFICATION_FAILED,
      permissionStatus: probe.permissionStatus || (denied ? "denied" : "unknown"),
      reportedCoords: null,
      latitudeDelta: null,
      longitudeDelta: null,
      lastVerifiedAt: checkedAt,
      lastError: probe.error || "Geolocation verification failed.",
      limitationNote: BROWSER_GPS_LIMITATION_NOTE,
    };
  }

  const coordCheck = validateReportedCoords(probe);
  if (!coordCheck.valid) {
    return {
      state: LOCATION_STATES.VERIFICATION_FAILED,
      permissionStatus: probe.permissionStatus || "granted",
      reportedCoords: null,
      latitudeDelta: null,
      longitudeDelta: null,
      lastVerifiedAt: checkedAt,
      lastError: coordCheck.error,
      limitationNote: BROWSER_GPS_LIMITATION_NOTE,
    };
  }

  const comparison = compareCoordinates({
    expectedLatitude,
    expectedLongitude,
    reportedLatitude: coordCheck.coords.latitude,
    reportedLongitude: coordCheck.coords.longitude,
    toleranceDegrees,
  });

  return {
    state: comparison.matches ? LOCATION_STATES.GPS_VERIFIED : LOCATION_STATES.LOCATION_MISMATCH,
    permissionStatus: probe.permissionStatus || "granted",
    reportedCoords: coordCheck.coords,
    latitudeDelta: comparison.latitudeDelta,
    longitudeDelta: comparison.longitudeDelta,
    lastVerifiedAt: checkedAt,
    lastError: comparison.matches
      ? null
      : `Reported coordinates (${coordCheck.coords.latitude}, ${coordCheck.coords.longitude}) differ from configured (${expectedLatitude}, ${expectedLongitude}).`,
    limitationNote: BROWSER_GPS_LIMITATION_NOTE,
  };
}
