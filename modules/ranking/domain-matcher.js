/**
 * Domain normalization and exact/subdomain matching for organic SERP results.
 */

export function normalizeDomain(domainOrUrl) {
  const raw = String(domainOrUrl || "").trim().toLowerCase();
  if (!raw) return "";

  const candidate = raw.includes("://") ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    let host = (parsed.hostname || "").toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }
    if (!host || /\s/.test(host) || (!host.includes(".") && host !== "localhost")) {
      return "";
    }
    return host;
  } catch {
    return "";
  }
}

export function extractHostname(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    let host = (parsed.hostname || "").toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }
    return host;
  } catch {
    return "";
  }
}

/**
 * Return true only if resultUrl belongs to targetDomain or one of its subdomains.
 * Example: example.com matches example.com, www.example.com, blog.example.com,
 * and rejects fakeexample.com and example.com.otherwebsite.com.
 */
export function isTargetDomainMatch({ resultUrl, targetDomain }) {
  const target = normalizeDomain(targetDomain);
  const resultHost = extractHostname(resultUrl);
  if (!target || !resultHost) {
    return false;
  }
  return resultHost === target || resultHost.endsWith(`.${target}`);
}

export function normalizeUrlForDedupe(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${host}${path}${parsed.search}`;
  } catch {
    return String(url || "").trim();
  }
}

