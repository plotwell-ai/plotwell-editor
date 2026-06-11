# plotwell Demo Recordings

Playwright-based demo recording scripts for the plotwell platform.

## Setup

```bash
cd plotwell-tools/demo-recordings
npm install
npx playwright install chromium
```

Copy `.env.example` to `.env` and fill in your demo account credentials:

```bash
cp .env.example .env
```

## Prerequisites

Before running, make sure both services are running:

- **Landing**: `cd plotwell-landing && npm run dev` (port 5174)
- **App**: `cd plotwell-app && npm run dev` (port 5173)
- **Backend**: `cd plotwell-backend && npm run dev:local` (port 3001)

## Run

```bash
# Single scenario
npm run demo:editor
npm run demo:checkout

# All scenarios
npm run demo:all
```

## Output

- `output/videos/` — full session recordings (webm)
- `output/screenshots/` — step-by-step screenshots (png)

All output is gitignored.
