# Digital Minds Keyword Ranking Automation

An internal, 100% free keyword ranking automation tool for **Digital Minds** that automates local Google organic rank tracking and updates client Google Sheets while preserving every detail of the existing sheet's formatting and history.

## Current Status

**All 11 Phases Completed** — see [ROADMAP.md](ROADMAP.md) for the full breakdown and [SHEET_REQUIREMENTS.md](SHEET_REQUIREMENTS.md) for the 24 non-negotiable Google Sheet preservation rules.

## Setup Instructions (Windows / PowerShell)

1. **Create and activate a virtual environment:**

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. **Install Python dependencies and Chromium:**

   ```powershell
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   .\.venv\Scripts\python.exe -m playwright install chromium
   ```

3. **Create your local environment and client files (never commit these):**

   ```powershell
   Copy-Item .env.example .env
   Copy-Item config\clients.example.json config\clients.json
   ```

## Running & Deployment

- **Check health & configuration:**

  ```powershell
  .\.venv\Scripts\python.exe main.py --check-health
  ```

- **Launch the Streamlit dashboard:**

  ```powershell
  .\.venv\Scripts\python.exe -m streamlit run dashboard/app.py
  ```

- **Generate the weekly Windows Task Scheduler script:**

  ```powershell
  .\.venv\Scripts\python.exe main.py --generate-scheduler-bat --weekday MON --start-time 09:00
  ```

- **Run the full test suite:**

  ```powershell
  .\.venv\Scripts\python.exe -m pytest -v
  ```
