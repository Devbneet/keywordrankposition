/**
 * Pure JavaScript SERP parser extracting genuine organic website results while
 * excluding ads, local packs, PAA, AI Overviews, shopping, carousels,
 * related searches, internal Google links, and nested sitelinks.
 */

import { detectGoogleBlock } from "../location/google-location-verifier.js";
import { normalizeUrlForDedupe } from "./domain-matcher.js";

const IGNORED_GOOGLE_HOSTS = new Set([
  "google.com",
  "accounts.google.com",
  "support.google.com",
  "maps.google.com",
  "policies.google.com",
  "shopping.google.com",
  "images.google.com",
  "translate.google.com",
  "googleadservices.com",
  "webcache.googleusercontent.com",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttributes(attrString) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = attrRegex.exec(attrString)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

function unwrapGoogleRedirect(rawHref) {
  try {
    const parsed = new URL(rawHref, "https://www.google.com");
    if (parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (target) return target;
    }
    return parsed.href;
  } catch {
    return rawHref;
  }
}

function isIgnoredUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return true;
    if (IGNORED_GOOGLE_HOSTS.has(host) || host.endsWith(".google.com") || host.includes(".google.")) {
      return true;
    }
    if (parsed.pathname.includes("/aclk")) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isExcludedContainer(tag, attrs) {
  const id = (attrs.id || "").toLowerCase();
  const cls = ` ${(attrs.class || "").toLowerCase()} `;
  const aria = (attrs["aria-label"] || "").toLowerCase();
  const attrid = (attrs["data-attrid"] || "").toLowerCase();
  const jsname = (attrs.jsname || "").toLowerCase();

  if (tag === "header" || tag === "footer" || tag === "nav" || tag === "script" || tag === "style") {
    return true;
  }
  if (tag === "g-scrolling-carousel") {
    return true;
  }
  // Ads / Sponsored
  if (
    id === "tads" ||
    id === "tadsb" ||
    id === "bottomads" ||
    attrs["data-text-ad"] !== undefined ||
    cls.includes(" ueierd ") ||
    cls.includes(" ads-ad ") ||
    cls.includes(" sponsored ") ||
    aria.includes("sponsored") ||
    aria === "ads"
  ) {
    return true;
  }
  // Local pack / Google Maps
  if (
    cls.includes(" local-pack ") ||
    cls.includes(" vkpgbb ") ||
    cls.includes(" aeprdc ") ||
    attrid.includes("kc:/local") ||
    attrs["data-local-attribute"] !== undefined ||
    aria.includes("local results")
  ) {
    return true;
  }
  // People Also Ask
  if (
    cls.includes(" related-question-pair ") ||
    attrs["data-q"] !== undefined ||
    attrs["data-initq"] !== undefined ||
    jsname === "cpkphb" ||
    aria.includes("people also ask")
  ) {
    return true;
  }
  // AI Overview
  if (
    cls.includes(" ai-overview ") ||
    attrid === "sge" ||
    attrs["data-sge"] !== undefined ||
    aria.includes("ai overview")
  ) {
    return true;
  }
  // Shopping ads
  if (
    cls.includes(" pla-unit ") ||
    cls.includes(" cu-container ") ||
    cls.includes(" commercial-unit-desktop-top ") ||
    attrs["data-pla"] !== undefined ||
    aria.includes("shopping")
  ) {
    return true;
  }
  // Image / Video carousels & Related searches
  if (
    id === "bres" ||
    cls.includes(" img-carousel ") ||
    cls.includes(" vid-carousel ") ||
    cls.includes(" video-voyager ") ||
    cls.includes(" related-searches ") ||
    attrid.includes("video") ||
    attrid.includes("image") ||
    aria.includes("related searches")
  ) {
    return true;
  }
  // Sitelink containers inside organic cards
  if (
    cls.includes(" sitelinks ") ||
    cls.includes(" osl ") ||
    cls.includes(" jmjoFb ".toLowerCase()) ||
    cls.includes(" mslg ") ||
    cls.includes(" hihjcd ") ||
    cls.includes(" fxvunb ")
  ) {
    return true;
  }

  return false;
}

function isOrganicCardContainer(tag, attrs) {
  if (tag !== "div" && tag !== "article") return false;
  const cls = ` ${(attrs.class || "").toLowerCase()} `;
  return (
    cls.includes(" g ") ||
    cls.includes(" mjjyud ") ||
    cls.includes(" tf2cxc ") ||
    cls.includes(" organic-result ")
  );
}

function resolvePageUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl || "https://www.google.com").href;
  } catch {
    return href;
  }
}

/**
 * Parse genuine organic results and next-page URL from Google SERP HTML.
 */
export function parseGoogleSerpHtml({ html, pageUrl = "https://www.google.com/search" } = {}) {
  if (typeof html !== "string" || !html.trim()) {
    return {
      ok: false,
      blocked: false,
      parsingError: "Empty or missing SERP HTML.",
      results: [],
      nextPageUrl: null,
      confirmedEmpty: false,
    };
  }

  const blockReason = detectGoogleBlock({ html, pageUrl });
  if (blockReason) {
    return {
      ok: false,
      blocked: true,
      blockReason,
      parsingError: null,
      results: [],
      nextPageUrl: null,
      confirmedEmpty: false,
    };
  }

  // Verify the document looks like HTML rather than plain corrupted text
  if (!/<html|<body|<div|<a\b/i.test(html)) {
    return {
      ok: false,
      blocked: false,
      parsingError: "Supplied content is not valid SERP HTML.",
      results: [],
      nextPageUrl: null,
      confirmedEmpty: false,
    };
  }

  // Extract next-page pagination link before excluding footer/nav if pnnext is in nav/table
  let nextPageUrl = null;
  const nextMatch =
    /<a\b([^>]*?(?:id=["']pnnext["']|aria-label=["']Next(?:\s+page)?["'])[^>]*)>/i.exec(html);
  if (nextMatch) {
    const nextAttrs = parseAttributes(nextMatch[1]);
    if (nextAttrs.href) {
      nextPageUrl = resolvePageUrl(nextAttrs.href, pageUrl);
    }
  }

  const results = [];
  const seenUrls = new Set();

  // Walk tokens sequentially with depth stacks for excluded containers & organic cards
  const tokenRegex = /<!--[\s\S]*?-->|<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  const tagStack = [];
  let excludedDepth = 0;
  const cardStack = []; // tracks { depth, capturedPrimary }

  let currentAnchor = null; // { href, titleParts, insideH3 }
  let h3Depth = 0;

  let token;
  while ((token = tokenRegex.exec(html)) !== null) {
    const full = token[0];
    if (full.startsWith("<!--")) {
      continue;
    }

    if (token[3] !== undefined) {
      // Text node
      if (excludedDepth === 0 && currentAnchor && h3Depth > 0) {
        currentAnchor.titleParts.push(token[3]);
      }
      continue;
    }

    const tagName = token[1].toLowerCase();
    const rawAttrs = token[2] || "";
    const isClosing = full.startsWith("</");
    const isSelfClosing = rawAttrs.trim().endsWith("/") || VOID_TAGS.has(tagName);

    if (isClosing) {
      // Pop matching tag from stack
      while (tagStack.length > 0) {
        const popped = tagStack.pop();
        if (popped.excluded) {
          excludedDepth = Math.max(0, excludedDepth - 1);
        }
        if (popped.isCard && cardStack.length > 0) {
          cardStack.pop();
        }
        if (popped.tagName === "h3") {
          h3Depth = Math.max(0, h3Depth - 1);
        }
        if (popped.tagName === "a" && currentAnchor) {
          if (excludedDepth === 0 && currentAnchor.hadH3) {
            const activeCard = cardStack.length > 0 ? cardStack[cardStack.length - 1] : null;
            if (!activeCard || !activeCard.capturedPrimary) {
              const unwrapped = unwrapGoogleRedirect(currentAnchor.href);
              if (!isIgnoredUrl(unwrapped)) {
                const dedupeKey = normalizeUrlForDedupe(unwrapped);
                if (!seenUrls.has(dedupeKey)) {
                  seenUrls.add(dedupeKey);
                  results.push({
                    title: decodeEntities(currentAnchor.titleParts.join(" ")) || unwrapped,
                    url: unwrapped,
                  });
                  if (activeCard) {
                    activeCard.capturedPrimary = true;
                  }
                }
              }
            }
          }
          currentAnchor = null;
        }
        if (popped.tagName === tagName) {
          break;
        }
      }
      continue;
    }

    const attrs = parseAttributes(rawAttrs);
    const excluded = excludedDepth > 0 ? false : isExcludedContainer(tagName, attrs);
    const isCard = excludedDepth === 0 && !excluded && isOrganicCardContainer(tagName, attrs);

    if (!isSelfClosing) {
      tagStack.push({ tagName, excluded, isCard });
      if (excluded) {
        excludedDepth += 1;
      }
      if (isCard) {
        cardStack.push({ capturedPrimary: false });
      }
    }

    if (excludedDepth > 0 || isSelfClosing) {
      continue;
    }

    if (tagName === "a" && attrs.href) {
      currentAnchor = {
        href: attrs.href,
        titleParts: [],
        hadH3: false,
      };
    } else if (tagName === "h3") {
      h3Depth += 1;
      if (currentAnchor) {
        currentAnchor.hadH3 = true;
      }
    }
  }

  const confirmedEmpty =
    results.length === 0 &&
    /did not match any documents|no results found for/i.test(html);

  return {
    ok: true,
    blocked: false,
    parsingError: null,
    results,
    nextPageUrl,
    confirmedEmpty,
  };
}
