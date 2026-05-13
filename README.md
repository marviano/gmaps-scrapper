# Gmaps Scraper

> A Chrome extension that collects Google Maps place reviews from the open side panel and exports them as structured **JSON** or **CSV** — ready for analysis, reporting, or AI-assisted insights.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## Why This Exists

Getting reviews out of Google Maps manually is tedious. This extension automates the scroll, expand, and extract cycle — handling virtualized lists, truncated text, and lazy-loaded content — so you can focus on what the reviews actually say.

**What you get per review:**

| Field | Description |
|-------|-------------|
| `author` | Reviewer name |
| `rating` | Overall star rating (e.g. `"4 bintang"`) |
| `aspectRatings` | Sub-ratings per category (Food / Service / Atmosphere) |
| `text` | Full review body, expanded |
| `time` | Structured time object with ISO date, unit, amount, and edited flag |
| `photoCount` | Number of photos attached |
| `ownerReply` | Owner response text, if present |

---

## Requirements

- Google Chrome or any Chromium-based browser with extension support
- A Google Maps place page with the **Reviews / Ulasan** tab visible

---

## Installation

This extension is not on the Chrome Web Store. Install it as an unpacked extension:

1. Clone or download this repository
   ```bash
   git clone https://github.com/marviano/gmaps-scrapper.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the **`extension/`** folder inside this repo (the one containing `manifest.json`)

The extension icon will appear in your toolbar.

---

## Usage

1. Open Google Maps and navigate to a place
2. Click the **Reviews** tab so the review list is visible
3. Click the extension icon to open the popup
4. Choose how many reviews to collect: **20**, **30**, or **All**
5. Click **Start collecting** and wait
6. When done, click **Copy JSON** or **Download CSV**

> **Tip:** If the list looks stuck after switching targets (e.g. 20 → 30), start again without reloading the Maps tab — the extension resets state automatically.

---

## Output Format

### JSON

```json
{
  "author": "Sukma Juwita",
  "rating": "1 bintang",
  "aspectRatings": [
    { "label": "Makanan", "ratingText": "2" },
    { "label": "Layanan", "ratingText": "1" },
    { "label": "Suasana", "ratingText": "2" }
  ],
  "text": "sorry to say, kecewa banget sama pelayanan...",
  "time": {
    "raw": "10 bulan lalu",
    "iso": "2025-07-08",
    "unit": "month",
    "amount": 10
  },
  "photoCount": 1
}
```

### CSV

One row per review. Columns: `text`, `author`, `rating`, `aspectRatings_json`, `time_raw`, `time_iso`, `time_edited`, `photoCount`, `ownerReply`. UTF-8 with BOM for correct Excel rendering.

---

## Using Reviews with AI

The popup includes a built-in prompt template (Tutorial → Slide 3) you can copy and paste into Gemini or Claude along with your exported reviews for:

- Sentiment analysis
- Theme clustering
- Service quality summaries
- Actionable improvement suggestions

---

## Repository Structure

```
gmaps-scrapper/
├── extension/
│   ├── manifest.json        # MV3 manifest
│   ├── selectors.js         # Centralized DOM selectors (hotfix-friendly)
│   ├── content.js           # Scraping engine
│   ├── popup.html           # Extension popup UI
│   └── popup.js             # Popup logic, i18n, export
├── MAPS_REVIEWS_SCRAPER_AUDIT.md   # Technical internals reference
├── LICENSE
└── README.md
```

---

## How It Works

The content script runs only on Google Maps URLs. When you start a job:

1. It locates the reviews panel in the Maps side panel
2. Scrolls to trigger virtualized row loading
3. Clicks expand controls so truncated text is fully readable
4. Extracts structured fields from each review card
5. Persists results to `chrome.storage.local` as the job runs

The popup polls storage in real time and shows progress. When done, results are available for copy or download without any external server involved — **all data stays in your browser**.

---

## Known Limitations

- Google can change Maps DOM at any time; selectors may need updates after a Maps redesign
- Very large review lists (1000+) may stop early if the virtual list stabilizes before all rows load
- Shadow DOM elements are not currently traversed
- Relative timestamps are approximate (calculated from scrape time)

---

## Selector Hotfixing

If a Google Maps update breaks extraction, you can override specific selectors without updating the extension. In your browser console on the Maps tab:

```js
chrome.storage.local.set({
  gmapsSelectorOverride: {
    reviewExtractPrimary: ".YourNewClass"
  }
})
```

See `MAPS_REVIEWS_SCRAPER_AUDIT.md` for the full selector catalog.

---

## Disclaimer

This tool interacts with pages on `google.com` and `maps.google.com`. Automated scraping may conflict with Google's Terms of Service. You are solely responsible for how you use it and for compliance with applicable terms and laws. The software is provided **as-is** without warranty of any kind.

---

## License

[MIT](./LICENSE) © [marviano](https://github.com/marviano/gmaps-scrapper)
