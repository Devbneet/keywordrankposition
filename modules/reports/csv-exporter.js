/**
 * Safe CSV serializer with spreadsheet formula-injection sanitization (=, +, -, @, tab, CR).
 */

export function sanitizeCsvCell(value) {
  const str = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function serializeRowsToCsv(headers = [], rows = []) {
  const lines = [];
  if (headers.length > 0) {
    lines.push(headers.map(sanitizeCsvCell).join(","));
  }
  for (const row of rows) {
    lines.push(row.map(sanitizeCsvCell).join(","));
  }
  return lines.join("\n");
}

