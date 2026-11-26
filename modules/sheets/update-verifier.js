/**
 * Post-update spreadsheet verifier (Section 18).
 * Re-reads the updated sheet and checks shifted column coordinates, date headers,
 * ranking values, SERP URLs, historical preservation, formula adjustments, merges,
 * filters, conditional formatting, column widths, and website statistics.
 */

import { indexToColumnLetters } from "./sheet-range-validator.js";

function shiftFormulaRefsRightByOneCol(formula, insertedColNumber1Based) {
  // Expected relative single-column shift in A1 formula notation (e.g. H7 -> I7)
  return String(formula || "").replace(/(\$?)([A-Z]{1,3})(\$?\d+)/g, (match, absCol, colLet, rowPart) => {
    let colIdx = 0;
    for (let i = 0; i < colLet.length; i += 1) {
      colIdx = colIdx * 26 + (colLet.charCodeAt(i) - 64);
    }
    if (colIdx >= insertedColNumber1Based) {
      return `${absCol}${indexToColumnLetters(colIdx + 1)}${rowPart}`;
    }
    return match;
  });
}

export function verifyPostUpdateSpreadsheet({
  plan,
  preUpdateStructure,
  preUpdateDisplayRows = [],
  postUpdateStructure,
  postUpdateDisplayRows = [],
}) {
  const issues = [];
  const shift = plan.willInsertColumn ? 1 : 0;
  const targetColNum = plan.targetColIndex + 1;

  // 1. Verify historical date column shifts & counts
  const preHist = preUpdateStructure.historicalDateColumns || [];
  const postHist = postUpdateStructure.historicalDateColumns || [];

  if (plan.willInsertColumn) {
    const expectedTotalHist = preHist.length + (preUpdateStructure.latestDateHeader ? 1 : 0);
    if (postHist.length < expectedTotalHist) {
      issues.push(
        `Historical ranking columns count mismatch: expected at least ${expectedTotalHist}, found ${postHist.length}.`
      );
    }
    for (const expectedCol of plan.expectedHistoricalColumns || []) {
      const actual = postHist.find((h) => h.columnLetter === expectedCol.expectedColumn);
      if (!actual || actual.header !== expectedCol.header) {
        issues.push(
          `Expected shifted historical column ${expectedCol.expectedColumn} ('${expectedCol.header}'), found '${actual?.header || "missing"}'.`
        );
      }
    }
  } else if (postHist.length < preHist.length) {
    issues.push("Historical ranking columns were unexpectedly removed.");
  }

  // 2. Verify every repeated keyword table header has targetDateLabel in targetColIndex
  for (const hrNum of plan.headerRowNumbers || []) {
    const actualHeader = String(postUpdateDisplayRows[hrNum - 1]?.[plan.targetColIndex] || "").trim();
    if (actualHeader !== plan.targetDateLabel) {
      issues.push(
        `Header row ${hrNum} column ${plan.targetColumnLetter} expected '${plan.targetDateLabel}', found '${actualHeader || "blank"}'.`
      );
    }
  }

  // 3. Verify keyword order & non-target columns (Keyword/Volume/Comp/LP) remained identical
  const preKw = preUpdateStructure.keywordRows || [];
  const postKw = postUpdateStructure.keywordRows || [];
  if (preKw.length !== postKw.length) {
    issues.push(`Keyword row count changed (${preKw.length} -> ${postKw.length}).`);
  } else {
    for (let i = 0; i < preKw.length; i += 1) {
      const a = preKw[i];
      const b = postKw[i];
      if (a.rowNumber !== b.rowNumber || a.keyword !== b.keyword || a.landingPage !== b.landingPage) {
        issues.push(
          `Row ${a.rowNumber} identity or protected column changed ('${a.keyword}' -> '${b.keyword}').`
        );
      }

      // Check historical values in previous latest/historical cols remain preserved after shift
      if (shift === 1 && a.latestRankingDate) {
        const shiftedHistVal = b.historicalRankings?.[a.latestRankingDate] ?? "";
        if (String(shiftedHistVal) !== String(a.latestRank ?? "")) {
          issues.push(
            `Row ${a.rowNumber} previous latest ranking ('${a.latestRank}') failed to shift intact into '${a.latestRankingDate}'.`
          );
        }
      }
    }
  }

  // 4. Verify planned ranking updates & SERP URLs landed accurately
  const postByRow = new Map(postKw.map((r) => [r.rowNumber, r]));
  for (const upd of plan.rankUpdates || []) {
    const liveRow = postByRow.get(upd.rowNumber);
    if (!liveRow || String(liveRow.latestRank) !== String(upd.newRank)) {
      issues.push(
        `Row ${upd.rowNumber} ('${upd.keyword}') ranking value expected '${upd.newRank}', found '${liveRow?.latestRank || "blank"}'.`
      );
    }
  }
  for (const upd of plan.serpUpdates || []) {
    const liveRow = postByRow.get(upd.rowNumber);
    if (!liveRow || String(liveRow.serpUrl) !== String(upd.newSerpUrl)) {
      issues.push(
        `Row ${upd.rowNumber} ('${upd.keyword}') SERP URL expected '${upd.newSerpUrl}', found '${liveRow?.serpUrl || "blank"}'.`
      );
    }
  }

  // 5. Verify website statistics values remained unchanged
  for (const stats of preUpdateStructure.websiteStatsRows || []) {
    const rIdx = stats.rowNumber - 1;
    const preStatsRow = preUpdateDisplayRows[rIdx] || [];
    const postStatsRow = postUpdateDisplayRows[rIdx] || [];
    for (let c = 0; c < targetColNum - 1; c += 1) {
      if (String(preStatsRow[c] ?? "") !== String(postStatsRow[c] ?? "")) {
        issues.push(`Website statistics row ${stats.rowNumber} col ${indexToColumnLetters(c + 1)} was altered.`);
      }
    }
    if (plan.willInsertColumn) {
      const insertedStatsVal = String(postStatsRow[plan.targetColIndex] ?? "").trim();
      if (insertedStatsVal && insertedStatsVal !== plan.targetDateLabel) {
        issues.push(`Website statistics new column cell row ${stats.rowNumber} must remain blank (found '${insertedStatsVal}').`);
      }
    }
  }

  // 6. Verify merges, filters, conditional formatting, formulas (allowing legitimate +1 column shift) & column widths
  if ((preUpdateStructure.mergedRanges || []).length !== (postUpdateStructure.mergedRanges || []).length) {
    issues.push("Merged cell ranges count changed unexpectedly.");
  }
  if (Boolean(preUpdateStructure.hasFilter) !== Boolean(postUpdateStructure.hasFilter)) {
    issues.push("Spreadsheet filter state changed unexpectedly.");
  }
  if (
    Number(preUpdateStructure.conditionalFormatsCount || 0) !==
    Number(postUpdateStructure.conditionalFormatsCount || 0)
  ) {
    issues.push("Conditional formatting rules count changed unexpectedly.");
  }

  const postFormulasByA1 = new Map((postUpdateStructure.formulaCells || []).map((f) => [f.a1, f.formula]));
  for (const preF of preUpdateStructure.formulaCells || []) {
    const expectedColNum = preF.colIndex + 1 >= targetColNum ? preF.colIndex + 1 + shift : preF.colIndex + 1;
    const expectedA1 = `${indexToColumnLetters(expectedColNum)}${preF.rowNumber}`;
    const liveFormula = postFormulasByA1.get(expectedA1);
    const expectedFormula = shift === 1 ? shiftFormulaRefsRightByOneCol(preF.formula, targetColNum) : preF.formula;
    if (!liveFormula) {
      issues.push(`Expected formula at '${expectedA1}' was missing after update.`);
    } else if (liveFormula !== expectedFormula && liveFormula !== preF.formula) {
      issues.push(`Formula at '${expectedA1}' changed unexpectedly ('${liveFormula}').`);
    }
  }

  const preWidth = (preUpdateStructure.formattingMetadata?.columnWidths || []).find(
    (w) => w.colIndex === plan.targetColIndex
  );
  if (preWidth?.pixelSize && postUpdateStructure.formattingMetadata?.columnWidths?.length) {
    const postWidth = postUpdateStructure.formattingMetadata.columnWidths.find(
      (w) => w.colIndex === plan.targetColIndex
    );
    if (postWidth && postWidth.pixelSize !== preWidth.pixelSize) {
      issues.push(`Column ${plan.targetColumnLetter} width (${postWidth.pixelSize}px) differs from template (${preWidth.pixelSize}px).`);
    }
  }

  return {
    verified: issues.length === 0,
    issues,
  };
}

