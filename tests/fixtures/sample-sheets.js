/**
 * Realistic fictional Google Sheets API v4 fixtures adhering to SHEET_REQUIREMENTS.md.
 */

export const FICTIONAL_SPREADSHEET_ID = "1FxTestSheetAgencyRankTracker999";
export const FICTIONAL_WORKSHEET_ID = "48291044";
export const FICTIONAL_WORKSHEET_NAME = "Sydney SEO";

export const SAMPLE_METADATA_RESPONSE = {
  spreadsheetId: FICTIONAL_SPREADSHEET_ID,
  properties: {
    title: "Apex Plumbing — Organic Rankings",
    locale: "en_AU",
    timeZone: "Australia/Sydney",
  },
  sheets: [
    {
      properties: {
        sheetId: 0,
        title: "Overview",
        index: 0,
        gridProperties: { rowCount: 40, columnCount: 10 },
      },
    },
    {
      properties: {
        sheetId: Number(FICTIONAL_WORKSHEET_ID),
        title: FICTIONAL_WORKSHEET_NAME,
        index: 1,
        gridProperties: { rowCount: 60, columnCount: 12 },
      },
      merges: [
        { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex: 8 },
        { startRowIndex: 15, endRowIndex: 16, startColumnIndex: 2, endColumnIndex: 5 },
      ],
      protectedRanges: [{ description: "Do not edit metrics", range: { startRowIndex: 1, endRowIndex: 5 } }],
      basicFilter: { range: { startRowIndex: 6, endRowIndex: 14, startColumnIndex: 2, endColumnIndex: 10 } },
    },
  ],
};

// Rows 1..20 (0-based indices 0..19)
export const SAMPLE_DISPLAY_ROWS = [
  ["", "", "Website Statistics — apexservices.example.com"], // Row 1 (merged banner)
  ["", "", "Semrush Authority Score", "34", "MOZ DA", "29"], // Row 2 (stats)
  ["", "", "Backlinks", "1420", "MOZ PA", "31"], // Row 3 (stats)
  [], // Row 4 blank
  ["", "", "Primary Plumbing Keywords"], // Row 5 group title before header
  ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November", "16-November", "09-November"], // Row 6 header
  ["", "", "emergency plumber sydney", "2400", "High", "/emergency", "https://apexservices.example.com/emergency", "2", "3", "4"], // Row 7
  ["", "", "blocked drains sydney", "1900", "Medium", "/blocked-drains", "https://apexservices.example.com/blocked-drains", "5", "6", "7"], // Row 8
  ["", "", "Total", "4300", "", "", "", "=AVERAGE", "", ""], // Row 9 summary metric row (excluded)
  [], // Row 10 blank separator
  [], // Row 11 blank separator
  ["", "", "Hot Water Keywords"], // Row 12 group banner before repeated header
  ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November", "16-November", "09-November"], // Row 13 repeated header
  ["", "", "emergency plumber sydney", "2400", "High", "/hot-water-emergency", "https://apexservices.example.com/hot-water-emergency", "9", "11", "10"], // Row 14 DUPLICATE keyword in row 14
  ["", "", "hot water repair", "880", "Low", "/hot-water", "NA", "NA", "19", "18"], // Row 15
];

export const SAMPLE_FORMULA_ROWS = [
  ["", "", "Website Statistics — apexservices.example.com"],
  ["", "", "Semrush Authority Score", "34", "MOZ DA", "29"],
  ["", "", "Backlinks", "=SUM(D100:D105)", "MOZ PA", "31"],
  [],
  ["", "", "Primary Plumbing Keywords"],
  ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November", "16-November", "09-November"],
  ["", "", "emergency plumber sydney", "2400", "High", "/emergency", '=HYPERLINK("https://apexservices.example.com/emergency","emergency")', "2", "3", "4"],
  ["", "", "blocked drains sydney", "1900", "Medium", "/blocked-drains", "https://apexservices.example.com/blocked-drains", "5", "6", "7"],
  ["", "", "Total", "=SUM(D7:D8)", "", "", "", "=AVERAGE(H7:H8)", "", ""],
  [],
  [],
  ["", "", "Hot Water Keywords"],
  ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November", "16-November", "09-November"],
  ["", "", "emergency plumber sydney", "2400", "High", "/hot-water-emergency", "https://apexservices.example.com/hot-water-emergency", "9", "11", "10"],
  ["", "", "hot water repair", "880", "Low", "/hot-water", "NA", "NA", "19", "18"],
];

export const SAMPLE_GRID_DETAILS = {
  spreadsheetId: FICTIONAL_SPREADSHEET_ID,
  properties: SAMPLE_METADATA_RESPONSE.properties,
  sheets: [
    {
      ...SAMPLE_METADATA_RESPONSE.sheets[1],
      data: [
        {
          rowMetadata: [{ pixelSize: 32 }, { pixelSize: 24 }, { pixelSize: 24 }, { pixelSize: 20 }, { pixelSize: 28 }, { pixelSize: 36 }],
          columnMetadata: [{ pixelSize: 40 }, { pixelSize: 40 }, { pixelSize: 260 }],
          rowData: SAMPLE_DISPLAY_ROWS.map((row, idx) => ({
            values: row.map((_val, colIdx) => {
              if (idx === 5 || idx === 12) {
                return { effectiveFormat: { backgroundColor: { red: 0.08, green: 0.16, blue: 0.35 }, textFormat: { bold: true } } };
              }
              if (idx === 6 && colIdx === 7) {
                return { effectiveFormat: { backgroundColor: { red: 0.85, green: 0.96, blue: 0.86 } } };
              }
              if (idx === 14 && colIdx === 7) {
                return { effectiveFormat: { backgroundColor: { red: 0.99, green: 0.95, blue: 0.7 } } };
              }
              return { effectiveFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } };
            }),
          })),
        },
      ],
    },
  ],
};

