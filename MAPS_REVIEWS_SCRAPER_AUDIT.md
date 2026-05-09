# Gmaps Scrapper — Technical audit document

**Audience:** Human auditors and AI coding agents integrating or reviewing this Chrome extension (Manifest V3).  
**Extension root:** `extension/` (manifest, popup, content script, selectors).

**Last updated:** 2026-05-08 — aligned with current `content.js`, `selectors.js`, `popup.js`, `manifest.json`.

---

## 1. Purpose

The extension automates collection of **visible** Google Maps place reviews from the open Maps side panel: scroll virtualized lists, expand truncated text where possible, extract structured fields per review, and persist results to `chrome.storage.local` for copy/export from the popup.

Maps UI is **unstable** (A/B tests, locales, Shadow DOM). The design favors resilience: centralized selectors (`selectors.js`), deep DOM queries in `content.js`, and explicit fallbacks.

---

## 2. Architecture

| Layer | Role |
|--------|------|
| **manifest.json** | MV3: `content_scripts` on Maps URLs; `storage` + `activeTab`; `icons` / `action.default_icon` under `ext-icons/` |
| **selectors.js** | Frozen default selectors on `globalThis.__GMAPS_SEL`; `VERSION` bumps when defaults change |
| **content.js** | Main scraper: scope, scroll, expand, extract, persist |
| **popup.html / popup.js** | UI, i18n, start/stop, CSV + JSON copy, review limits, wallet UI |

**Runtime selectors:** On each run, `mergeSelectorsFromStorage()` copies `__GMAPS_SEL` → `__GMAPS_SEL_ACTIVE`. All DOM access uses `sel()` → `__GMAPS_SEL_ACTIVE`.

**Cross-tab stop:** Popup writes `gmapsReviewsScraperStopSignal`; content listens on `chrome.storage.onMessage` and storage changes so Stop works without relying only on `tabs.sendMessage`.

---

## 3. Data flow (high level)

1. User opens a place on Google Maps and the **Reviews** panel.
2. Popup sends `GMAPS_REVIEWS_START` with optional `maxReviews`.
3. Content script `runJob()`:
   - Resets selectors from bundle.
   - `persistState({ status: "running", reviews: [], progress, maxReviews })`.
   - Resolves **reviews heading** and **scope** (scrollable panel).
4. Loop: `sweepOnce()` until idle, limit, or stop:
   - Scroll bursts (`scrollBurstLoad`) to grow the virtual list.
   - Optional “more reviews” style buttons.
   - **Expand** truncated review text (`queryExpandReviewTargets` + `gentleClick`).
   - Re-extract reviews; **persist** count/progress frequently (`persistLiveProgress`).

5. On completion or stop: `persistState` with final `reviews` and status.

6. Popup reads `gmapsReviewsScraperLastRun`, builds CSV / JSON via `buildReviewsCsv` / `buildExportRun`.

---

## 4. Review card model (current DOM)

Maps moved to card roots like **`DIV.jJc9Ad`** containing one review. Text may live in **`SPAN.wiI7pd`**; rating, time, contributor line, photos can sit in **siblings** inside the same card — not inside the text span.

**`getCardRoot(el)`** walks ancestors until `matches(sel().reviewExtractPrimary)` (e.g. `.jJc9Ad`, fallbacks `.MyEned`, `[data-review-id]`).  
**All secondary fields are queried from `card`, not from the bare text node.**

---

## 5. Extraction: `extractFromBlock(el)`

Called with either the **card** or an inner node (e.g. text span). Steps:

1. **`card = getCardRoot(el)`**  
2. **`text`**: **Only** from `sel().reviewTextPrimary` (e.g. `span.wiI7pd`) on `card`. No fallback to full `textContent`. If empty → `text` is `undefined`; `extractReviews()` skips rows with `text` shorter than 10 chars (star-only reviews are omitted by design).

3. **`author`**: Strict sources only — reviewer contrib link and first `authorTitle` node per selectors; `METADATA_NOISE_PATTERNS`, inline aspect parsing, `isValidAuthorName()`.

4. **`rating`**: `starsBlock` (e.g. `span.kvMYJc[aria-label]`); normalized via `normalizeRatingText`.

5. **`time`**: Relative string from `timeRelative` (e.g. `.DU9Pgb`, fallbacks). **No `meta` field** — removed.  
   **`postedAtApproximateIso`**: heuristic parse from `time` via `parseRelativeTimeToApproximateIso`.

6. **`contributorSummary`**: `contributorLine` (e.g. `.NsCY4`, `.RfnDt`), with **author prefix stripped** (`stripAuthorPrefixFromContributorSummary`), then trimmed.

7. **`photoCount`**: From `reviewPhotoButtons` (`button.Tya61d`): count visible photo buttons; **exclude** aria-labels starting with `+` for the main count; **add** overflow number parsed from labels like `+ 13 foto lainnya`. Fallback: distinct `reviewPhotoImages` URLs if no button count.

8. **`ownerReply`**: `reviewBlockLines(card, textEl)` + `extractOwnerReplyText`. Headers include Indonesian variants such as **`Tanggapan dari pemilik`**, **`Respons dari pemilik`**, plus other locales in `OWNER_REPLY_HEADERS`.

9. **`placeDetails` / `aspectRatings`**: key-value tuples vs aria-derived aspects, merged in `mergeAspectTuples`.

10. **`reviewId`**: from `data-review-id` when present. Popup export removes **`reviewId`** and **`placeUrl`** from copied JSON per product choice.

---

## 6. Algorithms

### 6.1 Sweep order and limits

**Order inside `sweepOnce`:** scroll / more buttons → scroll again → **expand** → final extract → persist.

**Limit (`maxReviews`):**  
`limitReached()` is based on `reviews.length` after slice. The **main run loop does not exit before `sweepOnce`** solely because of limit — expand runs before cap is applied within a sweep. After each sweep, if over cap, reviews are sliced.

### 6.2 Expand (`queryExpandReviewTargets`)

Collects controls that look like “read more” / `expandReview` jsaction, with locale patterns (`EXPAND_TRUNCATED_LABEL`, e.g. `lainnya`). **`gentleClick`** uses `block: "nearest"` to reduce scroll jumps. Expand targets sorted bottom-up where applicable.

### 6.3 Stop and invalidation

- `stopRequested` set on user stop signal or extension context invalidation.  
- `sleep()` is interruptible in small slices.

---

## 7. Data mapping: storage → clipboard JSON → CSV

This section is the **contract** for anyone parsing exports (auditors, downstream scripts, or AI agents).

### 7.1 Where data lives

| Location | Key / path | Notes |
|----------|------------|--------|
| `chrome.storage.local` | `gmapsReviewsScraperLastRun` | Single object = one “run” (last completed or in-progress scrape). |

**Run object (typical fields)** — exact keys depend on what `persistState()` merges in `content.js` / `popup.js`:

| Run-level key | Meaning |
|---------------|---------|
| `status` | e.g. `"running"`, `"done"`, `"error"` |
| `reviews` | Array of review objects (see §7.2) |
| `progress` | Counters: `expandClicks`, `moreReviewClicks`, `scrollSteps`, optional `lazyHeightGrows` |
| `placeUrl` | Current Maps URL when scrape ran (stored for context) |
| `maxReviews` | User cap (`number` or `null` = all) |
| `note`, `error`, `updatedAt` | UI / error / freshness |

### 7.2 One review object (as produced by `extractFromBlock` → `extractReviews`)

Each element of `run.reviews` is a **plain object**. Optional fields are often **omitted** when empty (deleted before return).

| Field | Type | Source meaning |
|-------|------|----------------|
| `text` | string \| omitted | Body of the review from **`reviewTextPrimary`** only (e.g. `wiI7pd`). Reviews without written text (or &lt; 10 chars after guards) are **not** kept in the array. |
| `author` | string \| omitted | Name from strict paths (contrib link / `authorTitle`); validated; no broad DOM guess. |
| `rating` | string \| omitted | Normalized headline rating text (often locale like `"4 bintang"`). |
| `time` | string \| omitted | Relative time phrase only (e.g. `"6 bulan lalu"`); **not** combined with rating. |
| `postedAtApproximateIso` | string \| omitted | Heuristic ISO-like date derived from `time` (approximate). |
| `photoCount` | number \| omitted | Thumbnail count + overflow from `Tya61d` logic, or image fallback. |
| `reviewerProfileUrl` | string \| omitted | Canonical contrib URL when a link is found. |
| `contributorSummary` | string \| omitted | e.g. Local Guide line; author prefix stripped. |
| `ownerReply` | string \| omitted | Text after an owner-reply header line. |
| `placeDetails` | array \| omitted | Label/value tuples (non-aspect “metadata” rows). |
| `aspectRatings` | array \| omitted | Aspect rows merged from tuples + aria. |
| `reviewId` | string \| omitted | `data-review-id` when Maps provides it. **Present in storage** until export. |

**Removed from current pipeline (do not expect in fresh runs):** `meta`, `relativeTimeRaw`. Legacy keys may still appear in old stored runs until overwritten.

### 7.3 Clipboard JSON — `buildExportRun(run)` (`popup.js`)

Purpose: **privacy / cleanliness** for “Copy JSON”, not a full diff of every runtime field.

**Run root**

| Transformation |
|----------------|
| `placeUrl` is **deleted** from the copied object (still OK in storage for the session). |
| `reviews` array is **cloned** per item. |

**Each review**

| Field | Clipboard |
|-------|-----------|
| `reviewId` | **Removed** (delete) |
| `meta`, `relativeTimeRaw` | **Removed** if present (legacy) |
| Everything else | Copied as-is (`text`, `author`, `rating`, `time`, `postedAtApproximateIso`, nested arrays, etc.) |

So: **clipboard JSON ⊂ stored run**, minus `placeUrl`, per-review `reviewId`, and legacy keys above.

### 7.4 CSV — `buildReviewsCsv(run)` (`popup.js`)

One **UTF-8** row per review, **header order fixed**. File is prefixed with a **BOM** (`\uFEFF`) so Excel opens UTF-8 correctly.

| Column header | Maps from review field | Format |
|----------------|-------------------------|--------|
| `text` | `r.text` | Plain string |
| `author` | `r.author` | Plain string |
| `rating` | `r.rating` | Plain string |
| `time` | `r.time` | Plain string (relative time) |
| `postedAtApproximateIso` | `r.postedAtApproximateIso` | Plain string |
| `photoCount` | `r.photoCount` | Number or empty cell |
| `reviewerProfileUrl` | `r.reviewerProfileUrl` | Plain string |
| `contributorSummary` | `r.contributorSummary` | Plain string |
| `ownerReply` | `r.ownerReply` | Plain string |
| `placeDetails_json` | `r.placeDetails` | **`JSON.stringify(r.placeDetails)`** if defined, else empty cell |
| `aspectRatings_json` | `r.aspectRatings` | **`JSON.stringify(r.aspectRatings)`** if defined, else empty cell |

**Escaping:** Values that contain comma, quote, or newline are CSV-escaped (`"` doubled inside quoted fields). Nested data is **never** split into multiple CSV columns except via the two `*_json` columns.

### 7.5 Quick reference matrix

| Field | Storage (`reviews[]`) | Copy JSON | CSV column |
|-------|----------------------|-----------|------------|
| `placeUrl` | Run root | **Stripped** | N/A (not a review column) |
| `reviewId` | Maybe | **Stripped** | Not exported |
| `text` … `ownerReply` | Yes | Yes | Same name (flat) |
| `placeDetails` | Array | Yes | `placeDetails_json` |
| `aspectRatings` | Array | Yes | `aspectRatings_json` |

---

## 8. Icons

Manifest references PNGs under **`ext-icons/`** (e.g. `icon48.png`, `icon128.png`). Sizes **`16` / `32`** are optional; if files are missing, do not reference them in `manifest.json` or load will fail.

---

## 9. Failure modes (operational)

| Symptom | Likely cause | Mitigation |
|---------|----------------|------------|
| Empty rating/time | Selector drift or structure outside `card` | Update `selectors.js`; verify `reviewExtractPrimary` matches card root |
| Truncated text with `…` | Expand not matching new buttons | Extend `expandReviewJsaction` / label patterns |
| `expandClicks` high but still `…` | Virtual list / race | More scroll before expand; retries |
| Stop ignored | Message path only | Storage stop signal + interruptible sleep |
| Extension load error for icons | Missing path in manifest | Match filenames under `ext-icons/` exactly |

---

## 10. Files reference (audit checklist)

- `extension/manifest.json` — version, permissions, icons, content_scripts  
- `extension/selectors.js` — `VERSION`, all selector strings  
- `extension/content.js` — full pipeline  
- `extension/popup.js` — `buildExportRun`, `buildReviewsCsv`, limits, i18n  

---

*End of document.*
