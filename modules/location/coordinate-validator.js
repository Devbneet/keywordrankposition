/**
 * Coordinate validation, country/language/domain presets, and paste-parsing utilities.
 */

export const DEFAULT_ACCURACY_METRES = 20;

export const SUPPORTED_COUNTRIES = Object.freeze({
  Australia: { code: "au", googleDomain: "google.com.au", defaultLanguage: "en-AU" },
  "United States": { code: "us", googleDomain: "google.com", defaultLanguage: "en-US" },
  "United Kingdom": { code: "uk", googleDomain: "google.co.uk", defaultLanguage: "en-GB" },
  Canada: { code: "ca", googleDomain: "google.ca", defaultLanguage: "en-CA" },
  India: { code: "in", googleDomain: "google.co.in", defaultLanguage: "en-IN" },
  "New Zealand": { code: "nz", googleDomain: "google.co.nz", defaultLanguage: "en-NZ" },
});

export const SUPPORTED_GOOGLE_DOMAINS = Object.freeze([
  "google.com.au",
  "google.com",
  "google.co.uk",
  "google.ca",
  "google.co.in",
  "google.co.nz",
]);

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

export function getCountryPreset(country) {
  return SUPPORTED_COUNTRIES[String(country || "").trim()] || SUPPORTED_COUNTRIES["United States"];
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
 * Validate location and Google target configuration using named object parameters.
 */
export function validateLocationInput({
  locationName = "",
  latitude,
  longitude,
  accuracy = DEFAULT_ACCURACY_METRES,
  targetCity = "",
  targetState = "",
  country = "Australia",
  language = "",
  googleDomain = "",
  deviceType = "Desktop",
  searchDepth = 50,
  reportingTimezone = "",
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

  const cleanCountry = String(country || "Australia").trim() || "Australia";
  const preset = getCountryPreset(cleanCountry);
  const cleanDomain = String(googleDomain || preset.googleDomain).trim().toLowerCase();
  if (!cleanDomain || !cleanDomain.includes("google.")) {
    errors.push("Google search domain must be a valid Google domain (e.g. google.com.au).");
  }

  const cleanLanguage = String(language || preset.defaultLanguage).trim() || preset.defaultLanguage;

  const warnings = [];
  if (SUPPORTED_COUNTRIES[cleanCountry] && cleanDomain !== preset.googleDomain) {
    warnings.push(
      `Country '${cleanCountry}' normally uses '${preset.googleDomain}', but '${cleanDomain}' is selected.`
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  return {
    valid: true,
    warnings,
    value: {
      locationName: String(locationName || "").trim(),
      latitude: parsedLat,
      longitude: parsedLng,
      accuracy: parsedAccuracy,
      targetCity: String(targetCity || "").trim(),
      targetState: String(targetState || "").trim(),
      country: cleanCountry,
      language: cleanLanguage,
      googleDomain: cleanDomain,
      deviceType: String(deviceType || "Desktop").trim() || "Desktop",
      searchDepth: Number(searchDepth) || 50,
      reportingTimezone: String(reportingTimezone || "").trim(),
      testPageUrl: cleanUrl,
    },
  };
}
