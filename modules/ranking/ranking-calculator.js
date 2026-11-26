/**
 * Calculate organic ranking position, ranking URL, and verified result evidence
 * across one or more parsed SERP pages.
 */

import { isTargetDomainMatch, normalizeUrlForDedupe } from "./domain-matcher.js";
import { RANKING_STATUSES } from "./ranking-state.js";

/**
 * Calculate ranking outcome from parsed SERP pages without fabricating results.
 */
export function calculateOrganicRanking({
  pages,
  targetDomain,
  requestedDepth,
  incompleteReason = null,
}) {
  const depth = Number(requestedDepth) || 50;
  const flattened = [];
  const seenUrls = new Set();
  let hasIncompletePage = Boolean(incompleteReason);
  let lastError = incompleteReason;

  for (const page of pages || []) {
    if (page.blocked) {
      return {
        status: RANKING_STATUSES.SEARCH_BLOCKED,
        position: null,
        rankingUrl: null,
        checkedResults: flattened.length,
        requestedDepth: depth,
        resultsTable: flattened,
        errorDetails: page.blockReason || "Google Search access restricted.",
      };
    }

    if (page.parsingError) {
      return {
        status: RANKING_STATUSES.PARSING_ERROR,
        position: null,
        rankingUrl: null,
        checkedResults: flattened.length,
        requestedDepth: depth,
        resultsTable: flattened,
        errorDetails: page.parsingError,
      };
    }

    if (page.incompleteReason) {
      hasIncompletePage = true;
      lastError = page.incompleteReason;
    }

    for (const item of page.results || []) {
      const dedupeKey = normalizeUrlForDedupe(item.url);
      if (seenUrls.has(dedupeKey)) {
        continue;
      }
      seenUrls.add(dedupeKey);

      const position = flattened.length + 1;
      flattened.push({
        position,
        title: item.title,
        url: item.url,
        pageNumber: page.pageNumber || 1,
        isTargetMatch: isTargetDomainMatch({ resultUrl: item.url, targetDomain }),
      });

      if (flattened.length >= depth) {
        break;
      }
    }

    if (flattened.length >= depth) {
      break;
    }
  }

  const matched = flattened.find((entry) => entry.isTargetMatch) || null;
  if (matched) {
    return {
      status: RANKING_STATUSES.RANKED,
      position: matched.position,
      rankingUrl: matched.url,
      checkedResults: flattened.length,
      requestedDepth: depth,
      resultsTable: flattened,
      errorDetails: null,
    };
  }

  // Never report NA ("Not found within verified search depth") when search was incomplete.
  if (hasIncompletePage) {
    return {
      status: RANKING_STATUSES.INCOMPLETE_SEARCH,
      position: null,
      rankingUrl: null,
      checkedResults: flattened.length,
      requestedDepth: depth,
      resultsTable: flattened,
      errorDetails: lastError || "Search ended before reaching requested depth.",
    };
  }

  return {
    status: RANKING_STATUSES.NOT_FOUND,
    position: null,
    rankingUrl: null,
    checkedResults: flattened.length,
    requestedDepth: depth,
    resultsTable: flattened,
    errorDetails: null,
  };
}
