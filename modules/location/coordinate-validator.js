/**
 * Coordinate validation and paste-parsing utilities using named parameters.
 */

export const DEFAULT_ACCURACY_METRES = 20;

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function parseFiniteNumber(value) {
  if (isBlank(value)) {
    return NaN;
  }
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(num) ? num : NaN;
}

/**
 * Parse a pasted coordinate pair such as "-33.8688, 151.2093".
 */
export function parseCoordinatePair(rawText) {
  if (isBlank(rawText)) {
    return { valid: false, error: "Coordinate text is blank." };
  }

  const trimmed = String(rawText).trim();
  const parts = trimmed.includes(",")
    ? trimmed.split(",").map((part) => part.trim())
    : trimmed.split(/\s+/);

  if (parts.length !== 2 || parts.some((p) => p === "")) {
    return {
      valid: false,
      error: "Expected two coordinates separated by a comma, e.g. -33.8688, 151.2093.",
    };
  }

  const latitude = parseFiniteNumber(parts[0]);
  const longitude = parseFiniteNumber(parts[1]);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { valid: false, error: "Latitude must be a finite number between -90 and +90." };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { valid: false, error: "Longitude must be a finite number between -180 and +180." };
  }

  return { valid: true, latitude, longitude };
}

/**
 * Validate location configuration fields using named object parameters.
 */
export function validateLocationInput({
  locationName = "",
  latitude,
  longitude,
  accuracy = DEFAULT_ACCURACY_METRES,
  country = "",
  language = "",
  testPageUrl = "",
} = {}) {
  const errors = [];

  const parsedLat = parseFiniteNumber(latitude);
  if (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) {
    errors.push("Latitude must be a finite number between -90 and +90.");
  }

  const parsedLng = parseFiniteNumber(longitude);
  if (!Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180) {
    errors.push("Longitude must be a finite number between -180 and +180.");
  }

  const resolvedAccuracy = accuracy === undefined ? DEFAULT_ACCURACY_METRES : accuracy;
  const parsedAccuracy = parseFiniteNumber(resolvedAccuracy);
  if (!Number.isFinite(parsedAccuracy) || parsedAccuracy <= 0) {
    errors.push("Accuracy must be a positive finite number in metres.");
  }

  const cleanUrl = String(testPageUrl || "").trim();
  if (cleanUrl) {
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        errors.push("Test page URL must use http:// or https://.");
      }
    } catch {
      errors.push("Test page URL is not a valid URL.");
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      locationName: String(locationName || "").trim(),
      latitude: parsedLat,
      longitude: parsedLng,
      accuracy: parsedAccuracy,
      country: String(country || "").trim(),
      language: String(language || "").trim(),
      testPageUrl: cleanUrl,
    },
  };
}

