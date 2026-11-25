"""Data models and configurable column mappings for Google Sheet structure detection."""

from __future__ import annotations

from dataclasses import dataclass, field


def col_letter_to_index(letter: str) -> int:
    """Convert an A1 column letter (e.g. 'C', 'H', 'AA') to a 0-based index."""
    cleaned = letter.strip().upper()
    if not cleaned or not cleaned.isalpha():
        raise ValueError(f"Invalid column letter: {letter!r}")
    index = 0
    for ch in cleaned:
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index - 1


def col_index_to_letter(index: int) -> str:
    """Convert a 0-based column index to an A1 column letter."""
    if index < 0:
        raise ValueError(f"Column index must be non-negative, got {index}")
    letters: list[str] = []
    current = index + 1
    while current > 0:
        current, remainder = divmod(current - 1, 26)
        letters.append(chr(ord("A") + remainder))
    return "".join(reversed(letters))


class SheetStructureError(ValueError):
    """Raised when a worksheet does not match the expected structure (Rule 23)."""


@dataclass(frozen=True)
class ColumnMapping:
    """Configurable column letters for client worksheets (Rule 24)."""

    keyword: str = "C"
    search_volume: str = "D"
    competition: str = "E"
    landing_page: str = "F"
    serp_url: str = "G"
    latest_date_start: str = "H"

    @property
    def keyword_idx(self) -> int:
        return col_letter_to_index(self.keyword)

    @property
    def search_volume_idx(self) -> int:
        return col_letter_to_index(self.search_volume)

    @property
    def competition_idx(self) -> int:
        return col_letter_to_index(self.competition)

    @property
    def landing_page_idx(self) -> int:
        return col_letter_to_index(self.landing_page)

    @property
    def serp_url_idx(self) -> int:
        return col_letter_to_index(self.serp_url)

    @property
    def latest_date_start_idx(self) -> int:
        return col_letter_to_index(self.latest_date_start)

    @classmethod
    def from_dict(cls, data: dict[str, str]) -> ColumnMapping:
        return cls(
            keyword=data.get("keyword", "C"),
            search_volume=data.get("search_volume", "D"),
            competition=data.get("competition", "E"),
            landing_page=data.get("landing_page", "F"),
            serp_url=data.get("serp_url", "G"),
            latest_date_start=data.get("latest_date_start", "H"),
        )


@dataclass(frozen=True)
class SheetKeywordRow:
    """Single keyword row anchored by its 1-based worksheet row_number (Rule 19)."""

    row_number: int
    keyword: str
    search_volume: str = ""
    competition: str = ""
    landing_page: str = ""
    serp_url: str = ""
    latest_rank_value: str = ""


@dataclass(frozen=True)
class KeywordGroup:
    """A keyword table group starting at a repeated header row."""

    header_row: int
    date_headers: list[str] = field(default_factory=list)
    keyword_rows: list[SheetKeywordRow] = field(default_factory=list)


@dataclass(frozen=True)
class SheetStructure:
    """Detected layout of a client's keyword ranking worksheet."""

    spreadsheet_id: str
    worksheet_name: str
    column_mapping: ColumnMapping
    groups: list[KeywordGroup]
    sheet_id: int | None = None

    @property
    def header_rows(self) -> list[int]:
        return [group.header_row for group in self.groups]

    @property
    def all_keyword_rows(self) -> list[SheetKeywordRow]:
        rows: list[SheetKeywordRow] = []
        for group in self.groups:
            rows.extend(group.keyword_rows)
        return rows

    @property
    def total_keywords(self) -> int:
        return sum(len(group.keyword_rows) for group in self.groups)

    @property
    def latest_date_header(self) -> str | None:
        if not self.groups or not self.groups[0].date_headers:
            return None
        return self.groups[0].date_headers[0]

    def has_date_header(self, date_label: str) -> bool:
        """Return True if date_label already exists in the date columns (Rule 18)."""
        normalized = date_label.strip().lower()
        return any(
            header.strip().lower() == normalized
            for group in self.groups
            for header in group.date_headers
        )

