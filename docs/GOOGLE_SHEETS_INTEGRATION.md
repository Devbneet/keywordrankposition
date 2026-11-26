# Google Sheets Read-Only Integration Architecture (Phase 8)

## Design Principles
1. **Strictly Read-Only in Phase 8:** Every Google Sheets API call uses `GET` only (`spreadsheets.get`, `spreadsheets.values.get`, `spreadsheets.values.batchGet`). Any non-GET or mutation endpoint (`:batchUpdate`, `:append`, `:clear`, `:copyTo`) is rejected in `modules/sheets/sheets-api-client.js`.
2. **Existing Sheets Remain Unmodified:** Enforces `SHEET_REQUIREMENTS.md`. Metadata, formulas, merged cells, filters, protected ranges, website statistics rows, keyword groups, and formatting colors are detected and fingerprinted cleanly without alteration.
3. **Strict Worksheet & Range Safety:** Target worksheets are verified by exact `sheetId` (`gid`) or normalized title (`spreadsheet-validator.js`). The extension never silently falls back to `sheets[0]` if the configured worksheet cannot be verified. Multiple locations on the same client cannot target overlapping ranges or the same worksheet without an explicit strategy (`sheet-range-validator.js`).
4. **Row-Anchored Identity:** Imported keywords preserve 1-based spreadsheet row numbers (`rowNumber` / `rowPosition`). Duplicate keywords in different rows (e.g., Row 15 and Row 42) remain distinct records.
5. **No Token Persistence:** Access tokens remain inside Chrome's `chrome.identity` cache only. Local extension storage stores only connection status timestamps and non-secret structure snapshots (`sheet_snapshots`).

## Module Summary
- `modules/sheets/google-auth.js` — Chrome Identity OAuth client & error classifier
- `modules/sheets/sheets-api-client.js` — Read-only REST v4 client with field masks & bounded backoff retries
- `modules/sheets/spreadsheet-validator.js` — URL parser, `gid` extractor, strict worksheet resolver
- `modules/sheets/sheet-structure-detector.js` — Stats section, multi-group headers, separator rows, dates, formulas, merges & color detection
- `modules/sheets/keyword-importer.js` — Row-preserving importer, preview builder & bulk queue exporter
- `modules/sheets/sheet-snapshot.js` — Deterministic structure fingerprint for Phase 9 pre-write drift validation
- `modules/sheets/sheet-sync.js` — Confirmed-only diffing (added, removed, edited, moved rows, landing page & structure changes)
- `modules/sheets/sheet-range-validator.js` — Overlapping range & same-worksheet multi-location collision detection
- `modules/sheets/sheet-reader.js` — End-to-end read, structure analysis, preview & snapshot orchestrator

