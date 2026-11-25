# Digital Minds Keyword Ranking Automation

An internal, 100% free keyword ranking automation tool for **Digital Minds** that automates local Google organic rank tracking and updates client Google Sheets while preserving every detail of the existing sheet's formatting and history.

## Current Status

**Phase 1: Project setup and environment configuration** (Complete / In Verification)

## Project Structure

```text
keywordrankposition/
├── main.py                     # CLI entry point
├── requirements.txt            # Python dependencies
├── README.md                   # Project overview & setup guide
├── ROADMAP.md                  # 11-phase development roadmap
├── SHEET_REQUIREMENTS.md       # Non-negotiable Google Sheet preservation rules
├── .gitignore                  # Git ignore rules (secrets, venv, runtime data)
├── .env.example                # Environment variable template
├── config/
│   └── clients.example.json    # Sample client configuration (no real client data)
├── src/
│   ├── browser/                # Browser automation helpers (Phase 2+)
│   ├── location/               # Geolocation simulation (Phase 2+)
│   ├── ranking/                # Organic ranking detection (Phase 3+)
│   ├── sheets/                 # Google Sheets reading & updating (Phase 6+)
│   ├── storage/                # SQLite history & caching (Phase 4+)
│   └── utils/                  # Logging, config, & shared utilities
├── dashboard/                  # Streamlit dashboard (Phase 9)
├── tests/                      # Pytest suite & local smoke tests
├── data/                       # Local SQLite databases (gitignored)
├── backups/                    # Sheet backups before updates (gitignored)
├── logs/                       # Application logs (gitignored)
└── screenshots/                # Verification screenshots (gitignored)
```

## Setup Instructions (Windows / PowerShell)

1. **Create and activate a virtual environment:**

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. **Install Python dependencies:**

   ```powershell
   pip install -r requirements.txt
   ```

3. **Install Playwright's Chromium browser:**

   ```powershell
   playwright install chromium
   ```

4. **Create your local environment file (optional for Phase 1):**

   ```powershell
   Copy-Item .env.example .env
   ```

## Running the Project (Phase 1)

Check environment and configuration readiness:

```powershell
python main.py
```

Run the local browser smoke test with `pytest`:

```powershell
pytest -v
```
