# 🔥 Fire Safety DWG Checker v11 - High Resolution

## What's New in v11

**Problem:** v10 used Autodesk's 400×400 thumbnail — too small for Claude to read text and recognize fine details.

**Solution:** v11 uses **3 strategies** for maximum resolution:

### Strategy 1: Headless APS Viewer (Primary)
1. Upload DWG → APS translates to SVF2
2. Puppeteer opens the APS Viewer headlessly (no browser window needed)
3. Takes a **3840×2160** (4K) screenshot
4. Splits the screenshot into **6 zones** (3×2 grid) for detail analysis
5. Sends ALL images (full + 6 zones = **7 images**) to Claude Vision

### Strategy 2: Enhanced Thumbnail (Fallback)
If Puppeteer fails (e.g., on some servers):
1. Gets the 400×400 thumbnail from APS
2. Upscales to 1600×1600 with Lanczos3 sharpening
3. Sends to Claude Vision

### Strategy 3: Zone Analysis
- The 4K screenshot is split into a 3×2 grid
- Each zone is ~1280×1080 pixels
- Claude sees both the overview AND each zoomed-in zone
- This catches details like small text labels, pipe markings, symbols

## Setup

```bash
# Install dependencies
npm install

# Edit .env with your credentials
cp .env .env.local
nano .env

# Start
npm start
```

## Required in .env

```
APS_CLIENT_ID=your_id
APS_CLIENT_SECRET=your_secret
ANTHROPIC_API_KEY=sk-ant-api03-...
```

## Optional in .env

```
PORT=3000
SCREENSHOT_WIDTH=3840
SCREENSHOT_HEIGHT=2160
```

## How It Works

```
DWG File
  ↓
APS Upload & Translate (SVF2)
  ↓
Puppeteer Headless Browser
  ↓ loads APS Viewer
  ↓ waits for geometry
  ↓ fits to view
  ↓ white background
  ↓
Screenshot (3840×2160)
  ↓
Sharp splits into 6 zones
  ↓
Claude Vision API
  ↓ Full image + 6 zones
  ↓ Fire safety prompt
  ↓
JSON Results → Beautiful UI
```

## Notes

- Puppeteer needs Chrome/Chromium (installed automatically with `npm install`)
- First analysis takes ~2-3 minutes (APS translation + rendering + Claude analysis)
- Subsequent analyses of the same file are faster (APS caches translations)
