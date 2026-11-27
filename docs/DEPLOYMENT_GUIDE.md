# Deployment Guide — Internal Agency Release (`v1.0.0-rc.1`)

This guide covers packaging and deploying **Digital Minds Rank Tracker v1.0.0-rc.1** for internal agency use as an unpacked Chrome extension.

---

## 1. Build the Clean Release Package (`v1.0.0-rc.1`)

Run the release packaging script from the repository root:

```powershell
node scripts/package-release.mjs
```

This creates `dist/digital-minds-rank-tracker-v1.0.0-rc.1/` containing **only** runtime extension files:
- `manifest.json`
- `background/`
- `popup/`
- `dashboard/`
- `content/`
- `modules/`
- `utils/`
- `icons/`

Development-only files (`tests/`, `docs/`, `.venv/`, `.git/`, `package.json`, `ROADMAP.md`, etc.) are excluded from the runtime package.

---

## 2. Internal Agency Rollout Steps

1. **Distribute Package**: Share `dist/digital-minds-rank-tracker-v1.0.0-rc.1/` (or zip it for internal distribution).
2. **Load Unpacked in Chrome**: Follow [INSTALLATION_GUIDE.md](./INSTALLATION_GUIDE.md).
3. **Configure OAuth**: Follow [GOOGLE_CLOUD_SETUP.md](./GOOGLE_CLOUD_SETUP.md) for the assigned Chrome Extension ID.
4. **Run Sandbox Gate**: Complete [GOOGLE_SHEETS_SANDBOX_TESTING.md](./GOOGLE_SHEETS_SANDBOX_TESTING.md) before enabling any live sheet writes.
5. **Sign Off**: Complete [FINAL_TESTING_CHECKLIST.md](./FINAL_TESTING_CHECKLIST.md).

> **Branch Policy:** Keep `main` and `backup/python-version` untouched until all manual verification items are signed off by the project owner.

