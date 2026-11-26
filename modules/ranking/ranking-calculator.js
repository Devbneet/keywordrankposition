/**
 * Calculate organic ranking position, ranking URL, and verified result evidence
 * across one or more parsed SERP pages.
 */

import { isTargetDomainMatch, normalizeUrlForDedupe } from "./domain-matcher.js";
import { RANKING_STATUSES } from "./ranking-state.js";

/**
 * Calculate ranking outcome from parsed SERP pages without fabricating results.
 * Never returns "Not found within verified search depth" (NA) if the requested
 * depth was not checked and end-of-results was not genuinely verified.
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
  const pageList = Array.isArray(pages) ? pages : [];
  let hasIncompletePage = Boolean(incompleteReason) || pageList.length === 0;
  let lastError = incompleteReason || (pageList.length === 0 ? "No SERP pages were checked." : null);

  for (const page of pageList) {
    if (page.blocked) {
      return {
        status: RANKING_STATUSES.SEARCH_BLOCKED,
        position: null,
        rankingUrl: null,
        checkedResults: flattened.length,
        requestedDepth: depth,
        verifiedEndOfResults: false,
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
        verifiedEndOfResults: false,
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
      verifiedEndOfResults: true,
      resultsTable: flattened,
      errorDetails: null,
    };
  }

  const lastPage = pageList.length > 0 ? pageList[pageList.length - 1] : null;
  const reachedRequestedDepth = flattened.length >= depth;
  const genuineEndReached = Boolean(
    lastPage &&
      lastPage.endOfResultsVerified === true &&
      !lastPage.nextPageUrl &&
      !lastPage.incompleteReason
  );

  // Never report NA ("Not found within verified search depth") unless the requested
  // depth was checked OR a genuine end of Google results was verified.
  if (hasIncompletePage || (!reachedRequestedDepth && !genuineEndReached)) {
    const reason =
      lastError ||
      (lastPage?.nextPageUrl
        ? `Only ${flattened.length} of ${depth} requested organic results were checked before pagination stopped.`
        : `Checked ${flattened.length} of ${depth} requested results without verified end of results.`);
    return {
      status: RANKING_STATUSES.INCOMPLETE_SEARCH,
      position: null,
      rankingUrl: null,
      checkedResults: flattened.length,
      requestedDepth: depth,
      verifiedEndOfResults: false,
      resultsTable: flattened,
      errorDetails: reason,
    };
  }

  return {
    status: RANKING_STATUSES.NOT_FOUND,
    position: null,
    rankingUrl: null,
    checkedResults: flattened.length,
    requestedDepth: depth,
    verifiedEndOfResults: true,
    resultsTable: flattened,
    errorDetails: null,
  };
}
