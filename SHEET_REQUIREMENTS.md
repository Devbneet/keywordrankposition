# Google Sheet Structure & Preservation Requirements

The existing client Google Sheet is the primary reporting document. All rules below are **non-negotiable** and must be enforced before any live sheet write is enabled in Phase 7.

## Reference Sheet Layout

- **Column C:** Keyword
- **Column D:** Search Volume
- **Column E:** Competition
- **Column F:** Landing Page
- **Column G:** SERP — actual ranking URL
- **Column H:** Latest ranking date
- **Column I onwards:** Previous ranking dates

### Additional Sheet Elements

- Website statistics section at the top (Semrush Authority Score, Backlinks, MOZ DA, MOZ PA).
- Multiple keyword groups with repeated keyword table headers.
- Empty separator rows between keyword groups.
- Dark navy-blue headers with white header text.
- Yellow, white, and green cell backgrounds.
- Existing borders, column widths, row heights, and filters.

## Mandatory Preservation Rules

1. Never redesign the existing Google Sheet.
2. Never delete or recreate the existing worksheet.
3. Never overwrite historical ranking data.
4. Never modify keywords, search volume, competition, or landing pages.
5. Never reorder keyword rows.
6. Preserve all existing colors, fonts, borders, and alignments.
7. Preserve merged cells, filters, formulas, column widths, and conditional formatting.
8. Preserve all keyword groups and blank separator rows.
9. Insert one new ranking date column immediately after the SERP column, shifting historical rankings to the right.
10. Copy the appropriate formatting from the previous ranking column into the new column.
11. Use the existing date format, such as `23-November` or `30-November`.
12. Update the date header across every keyword group.
13. Update the SERP column with the verified ranking URL only when a valid result is available.
14. Populate the new ranking column with the latest organic ranking positions.
15. Do not modify the existing website authority or backlink metrics. Leave the new date's corresponding metric cells empty unless separate data is available.
16. If the website is confirmed not ranking within the checked search depth, enter `NA`.
17. If a search fails or Google blocks access, do not report `NA` as a ranking result. Record the error separately.
18. Prevent duplicate date columns when the automation is executed multiple times on the same date.
19. Identify keyword rows using actual row positions, not just keyword text, because duplicate keywords may exist.
20. Create a backup before modifying a live client sheet.
21. Provide a dry-run preview before applying changes.
22. Use targeted Google Sheets API updates instead of replacing the entire sheet.
23. Detect unexpected changes in the sheet structure and stop safely.
24. Make sheet column mappings configurable because different clients may have slightly different sheet structures.

