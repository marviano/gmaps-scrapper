"use strict";

/** Set true only for local diagnostics; avoids production POST noise. */
const DEBUG_MODE = false;

const STORAGE_KEY = "gmapsReviewsScraperLastRun";
/** Bump this from the popup whenever the user hits Stop — works across tabs and does not rely on tab.sendMessage. */
const STOP_SIGNAL_KEY = "gmapsReviewsScraperStopSignal";

/** Writable copy; reset from extension/selectors.js at run start via `mergeSelectorsFromStorage()`. */
globalThis.__GMAPS_SEL_ACTIVE = { ...globalThis.__GMAPS_SEL };

/** @returns {Record<string, string>} */
function sel() {
  return globalThis.__GMAPS_SEL_ACTIVE;
}

/** Reset runtime selectors from bundled frozen defaults in selectors.js */
async function mergeSelectorsFromStorage() {
  globalThis.__GMAPS_SEL_ACTIVE = { ...globalThis.__GMAPS_SEL };
}

/**
 * Prefer word-boundary / prefix-ish matches: Google labels are often suffixed ("Ulasan (1,2 rb)").
 */
const REVIEW_SECTION_TITLE = [
  /^reviews?\b/i,
  /^ulasan\b/i,
  /^reseñas?\b/i,
  /^reseñas\s+de\s+google\b/i,
  /^avis\b/i,
  /^bewertungen\b/i,
  /^recensioni\b/i,
  /^avalia(ç|c)ões\b/i,
  /^レビュー/,
  /^口コミ/,
  /^리뷰/,
  /^评价|^評論/,
  /^ความเห็น/,
  /^รีวิว/,
];

const MORE_REVIEWS_PATTERNS = [
  /\bmore reviews\b/i,
  /\breviews \(\d/i,
  /\bother reviews\b/i,
  /\bsee more reviews\b/i,
  /\bshow more reviews\b/i,
  /\bload more\b/i,
  /\bulasan lainnya\b/i,
  /\blihat ulasan lainnya\b/i,
  /\bulasan lain\b/i,
  /\bavis supplémentaires\b/i,
  /\bplus d'avis\b/i,
  /\bplus d\b.*\bavis\b/i,
  /\bweitere bewertungen\b/i,
  /\bmehr bewertungen\b/i,
  /\bmas rese\b/i,
  /\bmás reseñas\b/i,
  /\bmore opinions\b/i,
  /\bmais avalia\b/i,
  /\baltre recensioni\b/i,
];

const EXPAND_TRUNCATED_LABEL = [
  /\blainnya\b/i,
  /\bmore\b/i,
  /^more$/i,
  /\bread more\b/i,
  /\bsee more\b/i,
  /\bmehr\b/i,
  /\bweiter\b/i,
  /\bver m\b/i,
  /\bvoir plus\b/i,
  /\bafficher plus\b/i,
  /\bmostrar\b/i,
  /\bsegue\b/i,
  /\b続き\b/,
];

/**
 * Section headers for business owner replies (UI varies by locale).
 * Used to peel reply text away from reviewer content without relying on brittle classes.
 */
const OWNER_REPLY_HEADERS = [
  /^tanggapan\s+dari\s+pemilik\b/i,
  /^respons\s+dari\s+pemilik\b/i,
  /^balasan\s+dari\s+pemilik\b/i,
  /^jawaban\s+dari\s+pemilik\b/i,
  /^response\s+from\s+(the\s+)?owner\b/i,
  /^response\s+from\s+owner\b/i,
  /^owner\s+response\b/i,
  /^owner['']?s?\s+response\b/i,
  /^reply\s+from\s+(the\s+)?owner\b/i,
  /^réponse\s+(du\s+)?(propriétaire|gérant)/i,
  /^antwort\s+des\s+eigentümers\b/i,
  /^antwort\s+vom\s+inhaber\b/i,
  /^respuesta\s+del\s+propietario\b/i,
  /^risposta\s+del\s+(proprietario|titolare)\b/i,
  /^resposta\s+(do\s+)?propriet[aá]rio\b/i,
  /^ответ\s+/i,
  /^店主の回答\b/,
];

let stopRequested = false;
let runnerPromise = null;

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STOP_SIGNAL_KEY]) return;
    /** Ignore on idle tabs so `stopRequested` is not stuck true until the next Start. */
    if (!runnerPromise) return;
    stopRequested = true;
  });
} catch {
  /* ignore */
}

// #region agent log
/** Debug NDJSON ingest. No-op unless DEBUG_MODE — no PII. */
function __agentDbg(message, hypothesisId, data, loc = "content.js") {
  if (!DEBUG_MODE) return;
  fetch("http://127.0.0.1:7242/ingest/176c0b85-d0c0-41ef-a970-2527232dc552", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "0fdb9b",
    },
    body: JSON.stringify({
      sessionId: "0fdb9b",
      runId: "pre-fix",
      hypothesisId,
      location: loc,
      message,
      data: data || {},
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

/** Yields periodically so STOP is picked up promptly; resolves early when {@link stopRequested} is true. */
async function sleep(ms) {
  let left = Math.max(0, ms | 0);
  const slice = Math.min(left, 60);
  while (left > 0 && !stopRequested) {
    const step = Math.min(slice, left);
    await new Promise((r) => setTimeout(r, step));
    left -= step;
  }
}

function normalizeAria(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** `offsetParent` is often null for visible Maps nodes (contain, transforms, nested scrollers). */
function isElementBasicallyVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1;
}

function matchesAny(patterns, text) {
  const t = normalizeAria(text).toLowerCase();
  return patterns.some((re) => {
    try {
      return re.test(t);
    } catch {
      return false;
    }
  });
}

/**
 * True if `node` is `ancestor` or reachable upward through light parents and shadow hosts.
 * Needed when reviews live under shadow roots while `scope` stays in the light tree.
 */
function composedContains(ancestor, node) {
  if (!ancestor || !node) return false;
  try {
    if (ancestor.contains(node)) return true;
  } catch (_) {
    /* ignore */
  }
  let cur = node;
  for (let i = 0; i < 400 && cur; i++) {
    if (cur === ancestor) return true;
    const p = cur.parentNode;
    if (p instanceof ShadowRoot) {
      cur = p.host;
      continue;
    }
    cur = p;
  }
  return false;
}

/**
 * `querySelectorAll` on `root` and every open shadow subtree under it (depth-first).
 * @param {Element | ShadowRoot | Document} root
 * @param {string} selector
 * @returns {Element[]}
 */
function deepQueryScoped(root, selector) {
  if (!root || !selector) return [];
  const seen = new Set();
  const acc = [];

  function visit(node) {
    if (!node) return;
    let searchRoot = null;
    if (node instanceof Document) {
      visit(node.documentElement);
      return;
    }
    if (node instanceof ShadowRoot) searchRoot = node;
    else if (node instanceof Element) searchRoot = node;
    else return;

    try {
      searchRoot.querySelectorAll(selector).forEach((el) => {
        if (el instanceof Element && !seen.has(el)) {
          seen.add(el);
          acc.push(el);
        }
      });
    } catch {
      return;
    }

    try {
      searchRoot.querySelectorAll("*").forEach((child) => {
        if (child instanceof Element && child.shadowRoot) visit(child.shadowRoot);
      });
    } catch {
      /* ignore */
    }
  }

  visit(root);
  return acc;
}

/**
 * @param {Element | ShadowRoot | Document} root
 * @param {string} selector
 */
function deepQueryFirst(root, selector) {
  const a = deepQueryScoped(root, selector);
  return a[0] ?? null;
}

/**
 * `getElementById` does not pierce shadow DOM; this does.
 * @param {string} id
 */
function deepGetElementById(id) {
  if (!id || typeof id !== "string") return null;
  /** @type {string} */
  let esc;
  try {
    esc = CSS.escape(id);
  } catch {
    esc = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  return deepQueryFirst(document.documentElement, `#${esc}`);
}

/**
 * Strip icon-font / zero-width junk so relative phrases like "10 bulan lalu" can parse.
 * @param {string} s
 */
function sanitizeRelativeTimeInput(s) {
  return normalizeAria(
    (s || "")
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/\uFEFF/g, "")
      .replace(/[\u200B-\u200D]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Full structured relative time. `iso` is UTC calendar date via `toISOString().slice(0, 10)`.
 * Alias historically used in extraction: parseRelativeTimeStructured → same implementation.
 * @param {string} rawInput
 * @param {number} refMs
 * @returns {{ raw: string, iso: string | null, unit?: string, amount?: number, edited?: boolean }}
 */
function parseRelativeTimeToApproximateIso(rawInput, refMs = Date.now()) {
  try {
    const rawOriginal = normalizeAria(rawInput || "");
    if (!rawOriginal) return { raw: "", iso: null };

    let edited = false;
    let s = sanitizeRelativeTimeInput(rawOriginal);
    if (/^diedit\s+/i.test(s)) {
      edited = true;
      s = s.replace(/^diedit\s+/i, "").trim();
    } else if (/^edited\s+/i.test(s)) {
      edited = true;
      s = s.replace(/^edited\s+/i, "").trim();
    }

    const t = s.toLowerCase();

    /** @type {{ unit: "hour" | "day" | "week" | "month" | "year"; amount: number } | null} */
    let parsed = null;

    if (/^baru\s+saja/i.test(t) || /^just\s+now/i.test(t)) parsed = { unit: "hour", amount: 0 };
    else if (/^kemarin/i.test(t) || /^yesterday/i.test(t)) parsed = { unit: "day", amount: 1 };
    else if (/^seminggu/i.test(t) || /\ba\s+week\b/i.test(s)) parsed = { unit: "week", amount: 1 };
    else if (/^sebulan/i.test(t) || /\ba\s+month\b/i.test(s)) parsed = { unit: "month", amount: 1 };
    else if (/^setahun/i.test(t) || /\ba\s+year\b/i.test(s)) parsed = { unit: "year", amount: 1 };
    else {
      let m = t.match(/(\d+)\s*jam\b/i);
      if (m) parsed = { unit: "hour", amount: parseInt(m[1], 10) };
      if (!parsed) {
        m = t.match(/(\d+)\s*hari\b/i);
        if (m) parsed = { unit: "day", amount: parseInt(m[1], 10) };
      }
      if (!parsed) {
        m = t.match(/(\d+)\s*minggu\b/i);
        if (m) parsed = { unit: "week", amount: parseInt(m[1], 10) };
      }
      if (!parsed) {
        m = t.match(/(\d+)\s*bulan\b/i);
        if (m) parsed = { unit: "month", amount: parseInt(m[1], 10) };
      }
      if (!parsed) {
        m = t.match(/(\d+)\s*tahun\b/i);
        if (m) parsed = { unit: "year", amount: parseInt(m[1], 10) };
      }
      if (!parsed) {
        m = t.match(
          /(\d+)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago/i
        );
        if (m) {
          const n = parseInt(m[1], 10);
          const w = m[2].toLowerCase();
          if (w.startsWith("second")) parsed = { unit: "hour", amount: 0 };
          else if (w.startsWith("minute")) parsed = { unit: "hour", amount: Math.min(Math.max(n, 1), 96) };
          else if (w.startsWith("hour")) parsed = { unit: "hour", amount: n };
          else if (w.startsWith("day")) parsed = { unit: "day", amount: n };
          else if (w.startsWith("week")) parsed = { unit: "week", amount: n };
          else if (w.startsWith("month")) parsed = { unit: "month", amount: n };
          else if (w.startsWith("year")) parsed = { unit: "year", amount: n };
        }
      }
      if (!parsed) {
        m = t.match(
          /(\d+)\s*(detik|menit|jam|hari|minggu|bulan|tahun)(?:\s+lalu|\s+yang\s+lalu)?/i
        );
        if (m) {
          const n = parseInt(m[1], 10);
          const u = m[2].toLowerCase();
          if (u === "detik") parsed = { unit: "hour", amount: 0 };
          else if (u === "menit") parsed = { unit: "hour", amount: Math.min(Math.max(n, 1), 96) };
          else if (u === "jam") parsed = { unit: "hour", amount: n };
          else if (u === "hari") parsed = { unit: "day", amount: n };
          else if (u === "minggu") parsed = { unit: "week", amount: n };
          else if (u === "bulan") parsed = { unit: "month", amount: n };
          else if (u === "tahun") parsed = { unit: "year", amount: n };
        }
      }
    }

    if (parsed && Number.isFinite(parsed.amount)) {
      const now = new Date(refMs);
      if (parsed.unit === "hour") now.setHours(now.getHours() - parsed.amount);
      else if (parsed.unit === "day") now.setDate(now.getDate() - parsed.amount);
      else if (parsed.unit === "week") now.setDate(now.getDate() - parsed.amount * 7);
      else if (parsed.unit === "month") now.setMonth(now.getMonth() - parsed.amount);
      else if (parsed.unit === "year") now.setFullYear(now.getFullYear() - parsed.amount);
      const iso = now.toISOString().slice(0, 10);
      /** @type {Record<string, unknown>} */
      const out = {
        raw: rawOriginal,
        iso,
        unit: parsed.unit,
        amount: parsed.amount,
      };
      if (edited) out.edited = true;
      return /** @type {*} */ (out);
    }

    return { raw: rawOriginal, iso: null };
  } catch {
    return { raw: normalizeAria(rawInput || ""), iso: null };
  }
}

/** @type {typeof parseRelativeTimeToApproximateIso} */
const parseRelativeTimeStructured = parseRelativeTimeToApproximateIso;

function isReviewHeading(el) {
  if (!(el instanceof Element)) return false;
  let txt =
    normalizeAria(el.textContent || "") ||
    normalizeAria(el.getAttribute?.("aria-label") || "");
  if (!txt && el.getAttribute("role") === "heading") txt = normalizeAria(el.textContent || "");
  if (!txt) return false;
  return REVIEW_SECTION_TITLE.some((re) => re.test(txt));
}

function findReviewsHeading() {
  function scan(root) {
    if (!(root instanceof Element) && !(root instanceof ShadowRoot)) return null;
    for (const cand of deepQueryScoped(root, sel().headingSelectors)) {
      if (!(cand instanceof HTMLElement)) continue;
      if (!isElementBasicallyVisible(cand)) continue;
      if (isReviewHeading(cand)) return cand;
    }
    /** Tab panels sometimes use a compact label-only node (<span>Ulasan</span>). */
    for (const cand of deepQueryScoped(root, sel().compactLabelRoots)) {
      if (!(cand instanceof HTMLElement)) continue;
      const tx = normalizeAria(cand.textContent || "");
      if (tx.length < 4 || tx.length > 140) continue;
      const kids = cand.children?.length ?? 0;
      if (kids > 6) continue;
      if (!isElementBasicallyVisible(cand)) continue;
      if (isReviewHeading(cand)) return cand;
    }
    return null;
  }

  const docHit = scan(document.body);
  if (docHit) return docHit;

  for (const tab of deepQueryScoped(document.body, sel().tabSelected)) {
    if (!(tab instanceof HTMLElement)) continue;
    const blob = normalizeAria(
      (tab.getAttribute("aria-label") || "") + "\n" + (tab.textContent || "")
    ).toLowerCase();
    if (!/\breviews?\b/i.test(blob) && !/\bulasan\b/i.test(blob) && !/\breseñas?\b/i.test(blob)) {
      continue;
    }
    const panelId = tab.getAttribute("aria-controls");
    if (!panelId) continue;
    const panel = deepGetElementById(panelId) || document.getElementById(panelId);
    const hit = panel ? scan(panel) : null;
    if (hit) return hit;
  }

  return null;
}

function findReviewsEntryButton() {
  /** Prefer place-panel tabs so we never grab the first random "ulasan" button in the tree. */
  /** @type {{ el: HTMLElement; score: number }[]} */
  const ranked = [];
  for (const el of deepQueryScoped(document.body, sel().tabButtonAnchor)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isElementBasicallyVisible(el)) continue;
    const blob = normalizeAria(
      (el.getAttribute("aria-label") || "") + "\n" + (el.textContent || "")
    ).toLowerCase();
    if (!blob) continue;
    const hasReview =
      /\breviews?\b/i.test(blob) || /\bulasan\b/i.test(blob) || /\breseñas?\b/i.test(blob);
    if (!hasReview) continue;
    const isTab = el.getAttribute("role") === "tab";
    const low = blob.replace(/\s+/g, " ");
    let score = isTab ? 80 : 10;
    if (isTab && /^ulasan\b/i.test(low)) score += 40;
    if (isTab && /^reviews?\b/i.test(low)) score += 40;
    if (/\bwrite\b.*\breview/i.test(low) || /\btulis\b.*\bulasan/i.test(low)) score -= 50;
    ranked.push({ el, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0]?.el ?? null;
}

/**
 * When Maps omits a recognizable h2 but the list is visible (common on the Reviews tab).
 * @returns {HTMLElement}
 */
function inferScopeFromReviewBlocks() {
  /** @type {HTMLElement | null} */
  let best = null;
  let bestScore = 0;

  function scoreFromAnchor(el) {
    if (!(el instanceof HTMLElement)) return;
    if (!isElementBasicallyVisible(el)) return;
    const text = normalizeAria(el.textContent || "");
    if (text.length < 8 && !el.hasAttribute("data-review-id")) return;
    const roots = findNearbyScrollRoots(el);
    const scope = roots[0] || el.closest(sel().scrollPanel) || el.parentElement;
    if (!(scope instanceof HTMLElement)) return;
    const n = deepQueryScoped(scope, sel().reviewHintsInScope).length;
    const s = Math.min(scope.scrollHeight, 50000);
    const score = n * 600 + s;
    if (score > bestScore) {
      bestScore = score;
      best = scope;
    }
  }

  for (const el of deepQueryScoped(document.body, sel().reviewHostsPrimary)) {
    scoreFromAnchor(el);
  }
  for (const el of deepQueryScoped(document.body, sel().dataReviewId)) {
    scoreFromAnchor(el);
  }
  for (const el of deepQueryScoped(document.body, sel().reviewTextSpans)) {
    scoreFromAnchor(el);
  }
  return best || document.body;
}

function hasAnyVisibleReviewBlock() {
  for (const el of deepQueryScoped(document.body, sel().visibleReviewBlocksGlob)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isElementBasicallyVisible(el)) continue;
    const t = normalizeAria(el.textContent || "");
    if (t.length >= 8) return true;
  }
  return false;
}

/** True if the page almost certainly has a reviews list (even when class names change). */
function documentHasReviewSignals() {
  if (hasAnyVisibleReviewBlock()) return true;
  for (const el of deepQueryScoped(document.body, sel().reviewSignalsSelectors)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isElementBasicallyVisible(el)) continue;
    return true;
  }
  return false;
}

async function ensureReviewsHeadingVisible() {
  let heading = findReviewsHeading();
  if (heading) return heading;

  const openBtn = findReviewsEntryButton();
  const reviewsTabAlreadySelected =
    openBtn?.getAttribute("role") === "tab" && openBtn.getAttribute("aria-selected") === "true";

  /**
   * Clicking the active Reviews tab again can toggle or remount the panel and leave you in a
   * brief empty state — which made "Ulasan first, then collect" fail.
   */
  if (openBtn && !reviewsTabAlreadySelected) {
    try {
      await gentleClick(openBtn);
      for (let w = 0; w < 12; w++) {
        await sleep(220);
        heading = findReviewsHeading();
        if (heading) return heading;
        if (documentHasReviewSignals()) return null;
      }
    } catch {
      /* ignore */
    }
  } else if (openBtn && reviewsTabAlreadySelected) {
    for (let w = 0; w < 16; w++) {
      await sleep(200);
      heading = findReviewsHeading();
      if (heading) return heading;
      if (documentHasReviewSignals()) return null;
    }
  }

  /**
   * Avoid resetting every .m6QErb on the page (there are often several). That can
   * virtualize away the open Reviews list when the user already had the Ulasan tab selected.
   */
  const side =
    deepQueryFirst(document.body, sel().sidebarScroller) ||
    deepQueryFirst(document.documentElement, sel().sidebarScroller);
  if (side instanceof HTMLElement) {
    try {
      side.scrollTop = 0;
    } catch {
      /* ignore */
    }
  }
  await sleep(400);
  heading = findReviewsHeading();
  if (heading) return heading;
  if (documentHasReviewSignals()) return null;

  await sleep(900);
  heading = findReviewsHeading();
  if (heading) return heading;
  return documentHasReviewSignals() ? null : findReviewsHeading();
}

function findNearbyScrollRoots(node) {
  /** @type {HTMLElement[]} */
  const out = [];
  let n = node;
  for (let i = 0; i < 24 && n; i++) {
    if (n instanceof HTMLElement) {
      const st = window.getComputedStyle(n);
      const oy = st.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        n.scrollHeight > n.clientHeight + 80
      ) {
        out.push(n);
      }
    }
    n = n.parentElement;
  }
  out.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return out;
}

function dedupePreferLarger(elements) {
  const arr = [...elements];
  arr.sort((a, b) => (b.offsetWidth * b.offsetHeight || 0) - (a.offsetWidth * a.offsetHeight || 0));
  /** @type {HTMLElement[]} */
  const kept = [];
  for (const el of arr) {
    const dup = kept.some((k) => k.contains(el) || el.contains(k));
    if (!dup) kept.push(el);
  }
  return kept;
}

/** Best-effort: panel subtree that holds review blocks and loaders */
function resolveReviewsScope(heading) {
  if (!(heading instanceof HTMLElement)) {
    return inferScopeFromReviewBlocks();
  }
  const scrollRoots = findNearbyScrollRoots(heading);
  if (scrollRoots.length) return scrollRoots[0];
  let p = heading.parentElement;
  for (let i = 0; i < 20 && p; i++) {
    if (p instanceof HTMLElement && p.scrollHeight > 800) return p;
    p = p.parentElement;
  }
  return document.body;
}

function queryExpandReviewTargets(scope) {
  /** @type {HTMLElement[]} */
  const out = [];

  /**
   * @param {Element} node
   * @param {boolean} forceInclude used for explicit jsaction expandReview hits
   */
  function consider(node, forceInclude = false) {
    if (!(node instanceof HTMLElement)) return;
    if (!composedContains(scope, node)) return;
    if (!isElementBasicallyVisible(node)) return;
    if (node instanceof HTMLButtonElement && node.disabled) return;
    if (node.getAttribute("role") === "button" && node.getAttribute("aria-disabled") === "true") return;
    if (node.getAttribute("aria-expanded") === "true") return;

    const blob =
      normalizeAria(node.getAttribute("aria-label") || "") +
      "\n" +
      normalizeAria(node.innerText || node.textContent || "");
    if (matchesAny(MORE_REVIEWS_PATTERNS, blob)) return;
    if (!forceInclude && !matchesAny(EXPAND_TRUNCATED_LABEL, blob)) return;
    out.push(node);
  }

  for (const node of deepQueryScoped(scope, sel().expandReviewJsaction)) {
    /** Explicit jsaction signal should count even when label text varies by locale/experiment. */
    consider(node, true);
  }
  for (const node of deepQueryScoped(scope, sel().expandReviewLainnya)) consider(node);
  for (const node of deepQueryScoped(scope, sel().ariaExpandedFalse)) consider(node);
  for (const node of deepQueryScoped(scope, sel().roleButtonVirtual)) consider(node);

  return [...new Set(out)];
}

function queryMoreReviewsButtons(scope) {
  /** @type {HTMLElement[]} */
  const found = [];

  function consider(b) {
    if (!(b instanceof HTMLElement)) return;
    if (!isElementBasicallyVisible(b)) return;
    if (b instanceof HTMLButtonElement && b.disabled) return;
    if (b.getAttribute("role") === "button" && b.getAttribute("aria-disabled") === "true") return;
    const aria = normalizeAria(b.getAttribute("aria-label") || "");
    const txt = normalizeAria(b.innerText || b.textContent || "");
    const blob = aria + "\n" + txt;
    if (!matchesAny(MORE_REVIEWS_PATTERNS, blob)) return;
    if (blob.includes("expandReview")) return;
    found.push(b);
  }

  for (const b of deepQueryScoped(scope, sel().allButtons)) {
    if (b instanceof HTMLButtonElement) consider(b);
  }
  for (const el of deepQueryScoped(scope, sel().roleButtonVirtual)) {
    consider(el);
  }
  return dedupePreferLarger(found).slice(0, 8);
}

function pickPrimaryScroll(scope) {
  const roots = findNearbyScrollRoots(scope);
  const big = roots[0];
  return big instanceof HTMLElement ? big : scope;
}

/**
 * Maps lazy-loads reviews inside a descendant scroller under the Reviews heading — not always an ancestor chosen by walking from `scope` alone.
 */
function findBestScrollContainer(scope, heading) {
  if (!(heading instanceof HTMLElement)) {
    /** Heading can disappear after first long pass due to Maps virtualized DOM. */
    let fallback = null;
    let score = -1;
    for (const el of deepQueryScoped(scope, sel().scrollPanel)) {
      if (!(el instanceof HTMLElement)) continue;
      if (!composedContains(scope, el)) continue;
      const st = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(st.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 48) continue;
      const s =
        deepQueryScoped(el, sel().scrollHintSelector).length * 220 +
        Math.min(el.scrollHeight, 120000);
      if (s > score) {
        score = s;
        fallback = el;
      }
    }
    return fallback;
  }
  /** @type {Map<HTMLElement, number>} */
  const map = new Map();

  function consider(el) {
    if (!(el instanceof HTMLElement)) return;
    if (!composedContains(scope, el)) return;
    const st = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(st.overflowY)) return;
    if (el.scrollHeight <= el.clientHeight + 48) return;
    const hints = deepQueryScoped(el, sel().scrollHintSelector).length;
    const score = hints * 220 + Math.min(el.scrollHeight, 120000);
    map.set(el, Math.max(map.get(el) || 0, score));
  }

  let n = heading.parentElement;
  for (let i = 0; i < 34 && n; i++) {
    consider(n);
    n = n.parentElement;
  }

  for (const el of deepQueryScoped(scope, sel().scrollPanel)) consider(el);

  /** @type {HTMLElement | null} */
  let best = null;
  let bestScore = -1;
  for (const [el, sc] of map) {
    if (sc > bestScore) {
      bestScore = sc;
      best = el;
    }
  }
  return best;
}

function resolveScrollEl(scope, heading) {
  const primary = findBestScrollContainer(scope, heading);
  if (primary instanceof HTMLElement) return primary;
  const fallback = pickPrimaryScroll(scope);
  return fallback instanceof HTMLElement ? fallback : null;
}

/**
 * Snap to bottom repeatedly so virtualized list mounts; bounce up/down to trigger IntersectionObservers.
 * @returns {Promise<boolean>} true if scrollHeight grew at least once during this burst
 */
async function scrollBurstLoad(scrollEl, progress, opts = {}) {
  const maxRounds = opts.maxRounds ?? 12;
  const stableExit = opts.stableExit ?? 4;
  /** Adaptive waits (ms): shrink when scrollHeight grows quickly; grow when idle. */
  const minW = opts.minWait ?? 220;
  const maxW = opts.maxWait ?? 920;
  let waitBottom = opts.initialBottomWait ?? 460;
  let waitWheel = opts.initialWheelWait ?? 200;

  if (!(scrollEl instanceof HTMLElement)) return false;
  let grew = false;
  let stable = 0;

  for (let i = 0; i < maxRounds && stable < stableExit && !stopRequested; i++) {
    const hBefore = scrollEl.scrollHeight;
    const targetTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    scrollEl.scrollTop = targetTop;
    await sleep(waitBottom);
    progress.scrollSteps += 1;

    try {
      scrollEl.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 1100, view: window })
      );
    } catch {
      /* ignore */
    }
    await sleep(waitWheel);

    if (scrollEl.scrollHeight > hBefore) {
      grew = true;
      progress.lazyHeightGrows = (progress.lazyHeightGrows || 0) + 1;
      stable = 0;
      const delta = scrollEl.scrollHeight - hBefore;
      /** Fast growth → shorter waits; tiny growth → slight lengthening */
      waitBottom = Math.max(minW, Math.floor(waitBottom * (delta > 400 ? 0.72 : 0.88)));
      waitWheel = Math.max(Math.floor(minW * 0.45), Math.floor(waitWheel * 0.9));
      continue;
    }

    waitBottom = Math.min(maxW, Math.floor(waitBottom * 1.08));
    waitWheel = Math.min(Math.floor(maxW * 0.45), Math.floor(waitWheel * 1.12));

    stable += 1;
  }

  return grew;
}

/**
 * Whether `el` lies outside the (padded) viewport — if false, skip scrollIntoView to avoid
 * Virtualized lists + `block: "center"` were pulling the panel from the bottom back to mid/top on every expand click.
 */
function elementNeedsScrollIntoView(el, pad = 10) {
  if (!(el instanceof Element)) return true;
  try {
    const r = el.getBoundingClientRect();
    const ih = window.innerHeight;
    const iw = window.innerWidth;
    return r.top < pad || r.bottom > ih - pad || r.left < pad || r.right > iw - pad;
  } catch {
    return true;
  }
}

/** Prefer targets already near the list bottom so we do not jump upward through the whole panel each sweep. */
function sortByViewportBottomDesc(nodes) {
  return [...nodes].sort(
    (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
  );
}

async function gentleClick(el) {
  if (elementNeedsScrollIntoView(el)) {
    try {
      el.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant" in window ? "instant" : "auto",
      });
    } catch {
      try {
        el.scrollIntoView(true);
      } catch {
        /* ignore */
      }
    }
  }
  await sleep(60);
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

function nodeFollowsHeading(heading, node) {
  if (!(heading instanceof Node)) return true;
  try {
    const pos = heading.compareDocumentPosition(node);
    /** Shadow/DOM quirks: do not hide all reviews behind a brittle ordering check. */
    if (!pos) return true;
    return Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  } catch {
    return true;
  }
}

function looksLikeStarAria(s) {
  const t = normalizeAria(s || "").toLowerCase();
  if (!t) return false;
  if (/[1-5]\s*bintang\b/.test(t)) return true;
  if (/\bstern(e)?\b/.test(t) && /\b[1-5]\b/.test(t)) return true;
  if (/\b([1-5])\s*(out\s+of\s+5\s+)?stars?\b/i.test(t)) return true;
  if (/\b([1-5])\s*[\/／]\s*5\b/.test(t)) return true;
  if (/\b([1-5])\s*stelle\b/i.test(t)) return true;
  return false;
}

function reviewBlockLines(el, textEl) {
  /** @type {Set<string>} */
  const exclude = new Set();
  const main = normalizeAria((textEl && textEl.textContent) || "");
  if (main)
    main.split(/\n/).forEach((ln) => {
      const x = normalizeAria(ln);
      if (x) exclude.add(x);
    });

  const lines = [];
  /** @type {Set<string>} */
  const gone = new Set();
  const raw = normalizeAria(el.innerText || el.textContent || "");
  raw.split(/\n/).forEach((chunk) => {
    const ln = normalizeAria(chunk);
    if (!ln || gone.has(ln)) return;
    gone.add(ln);
    lines.push(ln);
  });
  return { lines, mainTextLines: exclude };
}

function looksLikeContributorSummaryLine(ln) {
  const low = ln.toLowerCase();
  if (
    /\blocal\s+guide\b/i.test(ln) ||
    /\bpemandu\s+lokal\b/i.test(ln) ||
    /\bpanduan\s+lokal\b/i.test(ln)
  )
    return true;
  /** e.g. "123 ulasan · 190 foto" without explicit Local Guide wording */
  if (ln.includes("·") && /\d\s*(ulasan|reviews?|reseñas?|bewertungen?)\b/i.test(low)) return true;
  if (ln.includes("·") && /\d\s*(foto|photos?)\b/i.test(low)) return true;
  return false;
}

const METADATA_NOISE_PATTERNS = [
  /^tarif\s+per\s+orang\b/i,
  /^rp[\s\d]/i,
  /^\d[\d.,\s]*[–-][\d.,\s]*rb/i,
  /^jenis\s+makanan\b/i,
  /^jenis\s+pesanan\b/i,
  /^makanan\s*:/i,
  /^layanan\s*:/i,
  /^suasana\s*:/i,
  /^tingkat\s+kebisingan\b/i,
  /^tempat\s+parkir\b/i,
  /^opsi\s+tempat\s+parkir\b/i,
  /^ukuran\s+grup\b/i,
  /^waktu\s+tunggu\b/i,
  /^batasan\s+diet\b/i,
  /^kesesuaian\b/i,
  /^parkir\b/i,
  /^lainnya$/i,
  /^makan\s+(siang|malam|pagi)$/i,
  /^sarapan(\s+siang)?$/i,
  /^sangat\s+tenang$/i,
  /^tenang,?\s+mudah\s+untuk\s+bicara$/i,
  /^ramai(,\s+tetapi)?/i,
  /^kebisingan\s+sedang$/i,
  /^makan\s+di\s+tempat$/i,
  /^bawa\s+pulang$/i,
  /^pesan\s+antar$/i,
  /^banyak\s+tempat\s+parkir$/i,
  /^parkir\s+di\s+jalan/i,
  /^area\s+parkir/i,
  /^jenis\s+tempat\s+duduk/i,
  /^area\s+makan\s+dalam\s+ruangan/i,
  /^teras\s*\/?\s*teras\s+luar/i,
  /^tempat\s+duduk\s+di\s+bilik/i,
  /^sangat\s+rekom/i,
  /^tidak\s+menunggu$/i,
  /^maks\s+\d+/i,
  /^\d+\s*[-–]\s*\d+\s*orang$/i,
  /^\d+\s+orang$/i,
  /^cocok\s+untuk\s+semua\s+ukuran/i,
  /^cocok\s+untuk/i,
  /^(sangat\s+)?(tenang|ramai|bising)$/i,
  /makanan\s*:\s*\d.*layanan\s*:\s*\d/i,
];

function isMetadataNoiseAuthorCandidate(s) {
  const t = normalizeAria(s || "");
  if (!t) return true;
  if (METADATA_NOISE_PATTERNS.some((re) => re.test(t))) return true;
  return false;
}

/**
 * Inline aspect blob sometimes appears as a single line:
 * "Makanan: 5 Layanan: 5 Suasana: 5"
 * We parse it into aspect rows, but we do NOT treat the blob as `author`.
 * @param {string} str
 * @returns {{ label: string, value: string }[] | null}
 */
function parseInlineAspectRatingsTuples(str) {
  const t = normalizeAria(str || "");
  if (!t) return null;
  /** @type {{ label: string, value: string }[]} */
  const tuples = [];
  const patterns = [
    [/makanan\s*:\s*([1-5])/i, "Makanan"],
    [/layanan\s*:\s*([1-5])/i, "Layanan"],
    [/pelayanan\s*:\s*([1-5])/i, "Pelayanan"],
    [/suasana\s*:\s*([1-5])/i, "Suasana"],
    [/food\s*:\s*([1-5])/i, "Food"],
    [/service\s*:\s*([1-5])/i, "Service"],
    [/atmosphere\s*:\s*([1-5])/i, "Atmosphere"],
  ];
  const seen = new Set();
  for (const [re, lbl] of patterns) {
    const m = t.match(re);
    if (m && !seen.has(lbl)) {
      seen.add(lbl);
      tuples.push({ label: lbl, value: m[1] });
    }
  }
  return tuples.length ? tuples : null;
}

/**
 * Google often prints diner context above the review (order type, meal type, etc.) in the same
 * typography as names — those strings must never become `author`.
 */
function isLikelyReviewContextMetadataLine(s) {
  const t = normalizeAria(s || "");
  const low = t.toLowerCase();
  if (!t) return true;
  if (isMetadataNoiseAuthorCandidate(t)) return true;
  if (/\b(jenis|tipe)\s+pesanan\b/i.test(t)) return true;
  if (/\border\s+type\b/i.test(t)) return true;
  if (/^meal\s+type\b/i.test(t)) return true;
  if (/\bcara\s+pesanan\b/i.test(low)) return true;
  if (/\btempo\s+pelayanan\b/i.test(low)) return true;
  if (/\bwaiting\s+time\b/i.test(low)) return true;
  if (/\btipo\s+de\s+(pedido|orden)\b/i.test(low)) return true;
  if (/\btype\s+de\s+commande\b/i.test(low)) return true;
  if (/^(bawa\s+pulang|makan\s+di\s+tempat|takeaway|take[\s-]?out|dine[-\s]?in|delivery|pickup)\s*$/i.test(t))
    return true;
  return false;
}

/** Narrative review prose mis-picked when a wrapper reused author-ish classes */
function looksLikeSentenceNotAuthorName(s) {
  const t = normalizeAria(s || "");
  if (t.length < 28) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words >= 9) return true;
  if (/,/.test(t) && words >= 6) return true;
  if (/\b(jadi|kalau|karena|tapi|tetapi|however|because|although|yang|ini|itu|the|and|but)\b/i.test(t) && words >= 5)
    return true;
  return false;
}

function looksLikePossibleAuthorName(ln) {
  const t = normalizeAria(ln || "");
  if (!t) return false;
  if (t.length < 2 || t.length > 64) return false;
  if (looksLikeContributorSummaryLine(t)) return false;
  if (looksLikeStarAria(t)) return false;
  if (isLikelyReviewContextMetadataLine(t)) return false;
  if (looksLikeSentenceNotAuthorName(t)) return false;
  if (/^\d+(\.|,)?\d*$/.test(t)) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (/(ulasan|reviews?|reseñas?|bewertungen|foto|photos?)/i.test(t)) return false;
  if (/[{}\[\]|<>]/.test(t)) return false;
  if (/\s{3,}/.test(t)) return false;
  return true;
}

function stripGooglePhotoProfilePrefix(s) {
  let x = normalizeAria(s || "");
  if (!x) return "";
  for (const re of [
    /^foto\s+/i,
    /^photo\s+of\s+/i,
    /^lihat\s+foto\s+/i,
    /^view\s+photos?\s+of\s+/i,
    /^profil\s+/i,
    /^profile\s+/i,
    /^contributor\s+photo\s*-?\s*/i,
  ]) {
    x = x.replace(re, "").trim();
  }
  return x;
}

/**
 * Strict author source #1: first profile link in the review block.
 * We intentionally avoid scanning many nearby nodes to prevent free-text metadata leaks.
 * @param {HTMLElement} el
 * @returns {string}
 */
function extractAuthorFromReviewerProfileLink(el) {
  for (const first of deepQueryScoped(el, sel().reviewerProfileLink)) {
    if (!(first instanceof HTMLAnchorElement)) continue;
    const bits = [
      stripGooglePhotoProfilePrefix(first.getAttribute("aria-label") || ""),
      stripGooglePhotoProfilePrefix(first.getAttribute("title") || ""),
      normalizeAria(first.innerText || first.textContent || ""),
    ];
    for (const raw of bits) {
      if (!raw) continue;
      for (const line of raw.split(/\n/).map((x) => normalizeAria(x)).filter(Boolean)) {
        const cand = splitAuthorFromCombinedAuthorText(line);
        if (!cand) continue;
        if (isLikelyReviewContextMetadataLine(cand)) continue;
        if (!isValidAuthorName(cand)) continue;
        return cand;
      }
    }
  }
  return "";
}

/**
 * Strict author source #2: first author title node only.
 * @param {HTMLElement} el
 * @returns {string}
 */
/**
 * Names are sometimes concatenated with "Local Guide · …" or relative time in one node.
 * @param {string} s
 */
function splitAuthorFromCombinedAuthorText(s) {
  let t = normalizeAria(s);
  if (!t) return "";
  t = t.split(/\s+Local Guide\b/i)[0];
  t = t.split(/\b(?:pemandu|panduan)\s+lokal\b/i)[0];
  t = t.split(/[·•]/)[0];
  t = t.replace(/\s+\d+\s+(?:detik|menit|jam|hari|minggu|bulan|tahun)\s+lalu.*$/i, "");
  t = t.replace(/\s+(?:bulan|minggu|hari)\s+lalu.*$/i, "");
  t = normalizeAria(t.split("\n")[0]);
  return t;
}

function extractAuthorFromFirstTitleNode(el) {
  const nodes = [
    ...deepQueryScoped(el, sel().authorTitle),
    ...el.querySelectorAll(sel().authorTitle),
  ];
  const seen = new Set();
  for (const firstNode of nodes) {
    if (!(firstNode instanceof HTMLElement) || seen.has(firstNode)) continue;
    seen.add(firstNode);
    const fromAria = normalizeAria(firstNode.getAttribute("aria-label") || "");
    const fromText = normalizeAria(firstNode.textContent || "");
    const candidates = [];
    if (fromAria) candidates.push(splitAuthorFromCombinedAuthorText(fromAria));
    if (fromText) candidates.push(splitAuthorFromCombinedAuthorText(fromText));
    for (const cand of candidates) {
      if (!cand) continue;
      if (isLikelyReviewContextMetadataLine(cand)) continue;
      if (looksLikeContributorSummaryLine(cand) && cand.length > 40) continue;
      if (!isValidAuthorName(cand)) continue;
      return cand;
    }
  }
  return "";
}

/**
 * When name/reviewer block layout differs, first plausible personal-name line on the card.
 * @param {HTMLElement} card
 * @param {string | undefined} reviewText
 */
function extractAuthorFromCardLineFallback(card, reviewText) {
  const rt = normalizeAria(reviewText || "");
  const raw = normalizeAria(card.innerText || card.textContent || "");
  if (!raw) return "";
  const lines = raw.split(/\n/).map((x) => normalizeAria(x)).filter(Boolean);
  for (const ln of lines) {
    if (!ln) continue;
    if (rt && rt.length >= 12 && ln.includes(rt.slice(0, 24))) continue;
    if (looksLikeStarAria(ln)) continue;
    if (looksLikeContributorSummaryLine(ln) && /\d+\s*(ulasan|foto|reviews?)/i.test(ln)) continue;
    const cand = splitAuthorFromCombinedAuthorText(ln);
    if (!cand || cand.length < 2) continue;
    if (isLikelyReviewContextMetadataLine(cand)) continue;
    if (!isValidAuthorName(cand)) continue;
    return cand;
  }
  return "";
}

/**
 * Final guard so arbitrary free-text metadata values cannot be treated as names.
 * @param {string} str
 * @returns {boolean}
 */
function isValidAuthorName(str) {
  const s = normalizeAria(str || "");
  if (s.length < 2 || s.length > 60) return false;
  if (/^\d+$/.test(s)) return false;
  if (isMetadataNoiseAuthorCandidate(s)) return false;
  if (/^[1-5]\s*(bintang|stars?)(?:\s|$)/i.test(s)) return false;
  if (/local\s+guide|pemandu\s+lokal|panduan\s+lokal/i.test(s)) return false;
  if (/ulasan|foto/i.test(s)) return false;
  /** Time-like tokens often leak from contributor/time nodes */
  if (/^\d+\s*(bulan|tahun|minggu|hari|jam)\b/i.test(s)) return false;
  if (/^(sebulan|seminggu|setahun|kemarin|baru\s+saja)\b/i.test(s)) return false;
  /** Review/photo count fragments */
  if (/\d+\s*(ulasan|foto|review)\b/i.test(s)) return false;
  /** Indonesian number words used as fragments (e.g. "tiga") */
  if (/^(satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)$/i.test(s)) return false;
  if (/[!?]/.test(s)) return false;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)) return false;
  if (s.split(/\s+/).length > 6) return false;
  /** Icons / rating blobs often have no letters (e.g. PUA star glyphs + "3"). */
  if (!/\p{L}/u.test(s)) return false;
  /** Sentence-like or descriptor-like starts are usually metadata values, not names. */
  if (/^(bisa|lokasi|tempat|cocok|sangat|ramai|tenang|ada|untuk|parkir|makan|kid|family)\b/i.test(s))
    return false;
  /**
   * Reject sentence-like dots while allowing:
   * - leading initials: "J. Smith", "A. B. Last"
   * - middle initial after a first name: "Rinna D. Rahayu"
   */
  if (
    /\./.test(s) &&
    !/^([A-Za-z]\.){1,3}\s*[A-Za-z][A-Za-z' -]*$/.test(s) &&
    !/^[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z]\.)+(?:\s+[A-Za-z][A-Za-z'-]*)+$/.test(s)
  )
    return false;
  return true;
}

function normalizeRatingText(raw) {
  const t = normalizeAria(raw || "");
  if (!t) return "";
  if (looksLikeStarAria(t)) return t;
  const m =
    t.match(/([1-5](?:[.,]\d)?)\s*(?:out of 5\s*)?stars?/i) ||
    t.match(/([1-5](?:[.,]\d)?)\s*bintang/i) ||
    t.match(/([1-5](?:[.,]\d)?)\s*\/\s*5/i);
  if (m) return `${m[1]} stars`;
  return "";
}

/**
 * Single-digit aspect score 1–5 for `aspectRatings[].ratingText`.
 * @param {string} blob
 */
function normalizeAspectRatingDigit(blob) {
  const t = normalizeAria(blob || "");
  const m = t.match(/([1-5])/);
  return m ? m[1] : "";
}

/**
 * Structured "Foo: Bar" tuples often used for ordered dishes, vibes, accessibility, pricing, aspects, etc.
 * @returns {{ label: string, value: string }[]}
 */
function extractKeyValueTuples(lines, author, excludedMain, ownerReplyJoined, mainTextPrefix) {
  /** @type {{ label: string, value: string }[]} */
  const out = [];
  const KV_RE = /^([^:]{1,120}):\s*(.+)$/;
  /** Labels that rarely belong to diner metadata rows */
  const BAD_LABEL =
    /^https?:|^www\.|google maps|posted on|tanggal|^share\b|^like\b|^helpful\b/i;
  const prefix = normalizeAria(mainTextPrefix || "");

  /** @returns {boolean} */
  function isNoiseLabel(label) {
    const L = normalizeAria(label);
    if (!L) return true;
    /** Duplicated review prose or wrapper text */
    if (L.length > 80) return true;
    if (BAD_LABEL.test(L)) return true;
    if (prefix && L.toLowerCase().startsWith(prefix.toLowerCase())) return true;
    /** Aspect rating labels are not place-details; they belong to aspectRatings */
    if (/\b(makanan|layanan|suasana)\s*:/i.test(L)) return true;
    return false;
  }

  const seenPair = new Set();
  const orNorm = normalizeAria(ownerReplyJoined || "");
  for (const ln of lines) {
    if (!ln.includes(":")) continue;
    if (author && ln.startsWith(author)) continue;
    if (looksLikeContributorSummaryLine(ln)) continue;
    if (looksLikeStarAria(ln)) continue;

    const m = ln.match(KV_RE);
    if (!m) continue;

    let label = normalizeAria(m[1]);
    let value = normalizeAria(m[2]);
    if (!value || value.length > 560) continue;
    /** Single-digit aspect lines like "Makanan: 5" */
    if (!/^[0-9]+(?:[\.,]\d+)?$/.test(value) && label.length > 48 && ln.length > 240) continue;
    if (isNoiseLabel(label)) continue;

    const lowLabel = label.toLowerCase();
    if (
      /^(overall|rating)\b/i.test(label) ||
      lowLabel.includes("star") ||
      lowLabel.includes("bintang")
    )
      continue;

    /** Skip when this line belongs to owner's reply prose */
    if (orNorm && orNorm.includes(ln)) continue;

    const pairKey = `${label}::${value}`;
    if (seenPair.has(pairKey)) continue;
    /** Avoid stuffing the diner's prose if it casually uses ":" */
    if (excludedMain.has(ln) && value.split(/\s+/).length > 18) continue;

    seenPair.add(pairKey);
    out.push({ label, value });
  }
  return out;
}

/**
 * Narrative underneath an owner-response header.
 * @param {string[]} lines
 */
function extractOwnerReplyText(lines, mainTextExclude) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (OWNER_REPLY_HEADERS.some((re) => re.test(lines[i]))) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return undefined;
  /** @type {string[]} */
  const acc = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (!ln) continue;
    if (OWNER_REPLY_HEADERS.some((re) => re.test(ln))) break;
    if (looksLikeContributorSummaryLine(ln) && acc.length === 0) continue;
    acc.push(ln);
  }
  const joined = normalizeAria(acc.join("\n"));
  if (!joined || joined.length < 3) return undefined;
  if (mainTextExclude.has(joined)) return undefined;
  return joined;
}

/** Aspect label tokens (ID + EN) for matching aria / row text — case insensitive. */
const ASPECT_KEYWORD_RE =
  /\b(?:makanan|layanan|suasana|pelayanan|tempat|harga|kebersihan|kualitas|kenyamanan|nilai|food|service|atmosphere|location|price|cleanliness|value|quality|comfort|ambiance|ambience)\b/i;

/**
 * Scan card visible text for "Label: N" lines (1–5).
 * @param {HTMLElement} el
 * @returns {{ label: string, ratingText: string }[]}
 */
function extractAspectTuplesFromCardInnerText(el) {
  /** @type {{ label: string, ratingText: string }[]} */
  const out = [];
  const seen = new Set();
  const txt = normalizeAria(el.innerText || el.textContent || "");
  const re =
    /\b(makanan|layanan|suasana|pelayanan|tempat|harga|kebersihan|kualitas|kenyamanan|nilai|food|service|atmosphere|location|price|cleanliness|value|quality|comfort|ambiance|ambience)\s*:\s*([1-5])\b/gi;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const label = normalizeAria(m[1]);
    const digit = normalizeAspectRatingDigit(m[2]);
    if (!label || !digit) continue;
    const k = label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label, ratingText: digit });
  }
  return out;
}

/**
 * Walk up from an aspect star img to find a sibling label span.
 * @param {Element} img
 */
function inferAspectLabelNearStarImg(img) {
  /** @type {Element | null} */
  let host = img.parentElement;
  for (let d = 0; d < 8 && host; d++) {
    for (const sub of host.querySelectorAll(sel().spanAndDiv)) {
      if (!(sub instanceof HTMLElement)) continue;
      if (sub.contains(img)) continue;
      const tx = normalizeAria(sub.innerText || sub.textContent || "");
      if (!tx || tx.length > 56) continue;
      if (looksLikeStarAria(tx)) continue;
      if (ASPECT_KEYWORD_RE.test(tx)) {
        const seg = tx.split(/[.:]/)[0];
        return normalizeAria(seg);
      }
    }
    host = host.parentElement;
  }
  return "";
}

/**
 * Per-aspect rows from aria-labels like "Makanan, 5 bintang" or "Food: 5".
 * @returns {{ label: string, ratingText: string }[]}
 */
function extractAriaLabeledStars(el, primaryStarsEl) {
  /** @type {{ label: string, ratingText: string }[]} */
  const out = [];
  const seen = new Set();
  const primaryAria =
    primaryStarsEl instanceof Element ? normalizeAria(primaryStarsEl.getAttribute("aria-label") || "") : "";

  function pushAspect(labelRaw, ratingBlob) {
    const label = normalizeAria(labelRaw);
    const digit = normalizeAspectRatingDigit(ratingBlob);
    if (!label || !digit) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, ratingText: digit });
  }

  /**
   * @param {string} aria0
   * @param {Element | null} contextEl
   */
  function parseAria(aria0, contextEl) {
    const aria = normalizeAria(aria0);
    if (!aria || aria === primaryAria) return;
    const hasDigit = /[1-5]/.test(aria);
    if (!hasDigit) return;

    let m = aria.match(
      /^(.{1,80}?)[,，]\s*([1-5])(?:\s*[\/／]?\s*5)?(?:\s*(?:bintang|stars?|stern|stelle|sterne|étoiles?))?/i
    );
    if (m) {
      pushAspect(m[1], m[2]);
      return;
    }
    m = aria.match(/^(.{1,80}?)\s*:\s*([1-5])\b/);
    if (m) {
      pushAspect(m[1], m[2]);
      return;
    }
    if (looksLikeStarAria(aria) && ASPECT_KEYWORD_RE.test(aria)) {
      const lab = (aria.match(ASPECT_KEYWORD_RE) || [""])[0];
      if (lab) {
        pushAspect(lab, aria);
        return;
      }
    }
    if (looksLikeStarAria(aria) && contextEl instanceof Element && !ASPECT_KEYWORD_RE.test(aria)) {
      const inferred = inferAspectLabelNearStarImg(contextEl);
      if (inferred) pushAspect(inferred, aria);
    }
  }

  for (const node of el.querySelectorAll('[role="img"][aria-label]')) {
    if (!(node instanceof Element)) continue;
    if (node === primaryStarsEl) continue;
    const al = node.getAttribute("aria-label");
    if (al) parseAria(al, node);
  }

  for (const node of el.querySelectorAll("[aria-label]")) {
    if (!(node instanceof Element)) continue;
    if (node === primaryStarsEl) continue;
    if (node.getAttribute("role") === "img") continue;
    const al = node.getAttribute("aria-label");
    if (al) parseAria(al, node);
  }

  for (const node of el.querySelectorAll(sel().imgWithAriaLabel)) {
    if (!(node instanceof Element)) continue;
    if (node === primaryStarsEl) continue;
    const al = node.getAttribute("aria-label");
    if (al) parseAria(al, node);
  }

  return out;
}

/**
 * Per-aspect rows like "Food: 5" / "Makanan: 5" (localized labels vary).
 * @returns {boolean}
 */
function isAspectLabelValueTuple(t) {
  const L = normalizeAria(t.label);
  const v = normalizeAria(t.value);
  const aspectHints =
    /\b(makanan|food|comida|cuisine|rasa|servi(ce|s|cio)?|layanan|pelayanan|service|suasana|atmosphere|ambience|ambiente|tempat|lokasi|location|harga|price|nilai|value|kebersihan|cleanliness|kualitas|kenyamanan|quality|comfort|ambiance)\b/i;
  const aspectValue =
    /^[1-5]$/.test(v) ||
    /^[1-5]\s*[\/／]\s*5$/.test(v) ||
    /\bstars?\b/i.test(v) ||
    /\bbintang\b/i.test(v);
  return aspectHints.test(L) && aspectValue;
}

/**
 * Fuse aspect-like tuples (`Makanan: 5`) and aria-derived rows. Output `{ label, ratingText }` with digit-only ratingText.
 */
function mergeAspectTuples(kvTuples, ariaAspects, _overallAria) {
  /** @type {{ label: string, ratingText: string }[]} */
  const merged = [];
  const seen = new Set();

  for (const kv of kvTuples) {
    if (!isAspectLabelValueTuple(kv)) continue;
    const label = normalizeAria(kv.label);
    if (!label) continue;
    const digit = normalizeAspectRatingDigit(kv.value);
    if (!digit) continue;
    const k = label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ label, ratingText: digit });
  }

  for (const row of ariaAspects) {
    const label = normalizeAria(row.label);
    if (!label || label === "(aspect)") continue;
    const digit = normalizeAspectRatingDigit(row.ratingText);
    if (!digit) continue;
    const k = label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ label, ratingText: digit });
  }

  return merged;
}

/**
 * Resolve the stable review card root for field extraction.
 * The active selector set controls what qualifies as a root.
 * @param {HTMLElement} el
 * @returns {HTMLElement}
 */
function getCardRoot(el) {
  const rootSelector = sel().reviewExtractPrimary;
  let node = el;
  while (node && node !== document.body) {
    try {
      if (node.matches(rootSelector)) return node;
    } catch {
      /* ignore invalid selector edge cases */
    }
    node = node.parentElement;
  }
  return el;
}

function extractFromBlock(el) {
  const card = getCardRoot(el);

  /** Maps sometimes pins an id here or on ancestors */
  const ridAttr =
    card.getAttribute("data-review-id") ||
    card.closest("[data-review-id]")?.getAttribute("data-review-id") ||
    el.getAttribute("data-review-id") ||
    el.closest("[data-review-id]")?.getAttribute("data-review-id") ||
    undefined;

  const textEl =
    deepQueryScoped(card, sel().reviewTextPrimary)[0] ||
    card.querySelector(sel().reviewTextPrimary) ||
    null;
  const text = normalizeAria((textEl && textEl.textContent) || "") || undefined;

  /** @type {ScrapedReview} */
  const row = {
    text,
    author: undefined,
    rating: undefined,
    reviewId: ridAttr,
    placeDetails: undefined,
    aspectRatings: undefined,
    ownerReply: undefined,
    time: undefined,
    photoCount: undefined,
    reviewerProfileUrl: undefined,
  };

  const reviewTextNorm = normalizeAria(row.text || "");
  let authorCandidate =
    extractAuthorFromReviewerProfileLink(card) ||
    extractAuthorFromFirstTitleNode(card) ||
    extractAuthorFromCardLineFallback(card, row.text) ||
    "";

  /** If what we picked is actually inline aspect ratings, capture those and drop it as author. */
  let inlineAspectTuples = parseInlineAspectRatingsTuples(authorCandidate);
  if (inlineAspectTuples) {
    authorCandidate = "";
  }

  if (authorCandidate && isMetadataNoiseAuthorCandidate(authorCandidate)) {
    authorCandidate = "";
  }
  if (authorCandidate && !isValidAuthorName(authorCandidate)) {
    authorCandidate = "";
  }
  row.author = authorCandidate || undefined;

  /**
   * Additional fallbacks for unusual card structures.
   * These are only evaluated when the strict paths above fail.
   */
  if (!row.author) {
    // Fallback 1 — reviewer profile link (explicit Maps contrib href)
    const a = card.querySelector('a[href*="/maps/contrib/"]');
    if (a instanceof HTMLAnchorElement) {
      const cand = splitAuthorFromCombinedAuthorText(normalizeAria(a.textContent || ""));
      if (cand && isValidAuthorName(cand)) {
        row.author = cand;
      }
    }
  }

  if (!row.author) {
    // Fallback 2 — any heading-like node (avoid contributor summary lines using "·")
    const candNodes = card.querySelectorAll('[class*="d4r55"], [class*="NsCY4"]');
    for (const n of candNodes) {
      if (!(n instanceof HTMLElement)) continue;
      const tx = normalizeAria(n.textContent || "");
      if (!tx || tx.includes("·")) continue;
      const cand = splitAuthorFromCombinedAuthorText(tx);
      if (cand && isValidAuthorName(cand)) {
        row.author = cand;
        break;
      }
    }
  }

  if (!row.author) {
    // Fallback 3 — first short text node / inline element inside the card
    const BAD_INLINE = /\d+\s*(ulasan|reviews?|foto|photos?)\b/i;
    const BAD_GUIDE = /\blocal\s+guide\b|\b(pemandu|panduan)\s+lokal\b/i;

    /**
     * @param {Node} node
     * @returns {string}
     */
    function walk(node) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) {
        const tx = normalizeAria(node.textContent || "");
        if (
          tx.length >= 3 &&
          tx.length <= 60 &&
          !/^\d+$/.test(tx) &&
          !BAD_INLINE.test(tx) &&
          !BAD_GUIDE.test(tx) &&
          !looksLikeStarAria(tx)
        ) {
          const cand = splitAuthorFromCombinedAuthorText(tx);
          if (cand && isValidAuthorName(cand)) return cand;
        }
        return "";
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const eln = /** @type {Element} */ (node);
      // Inline-ish containers sometimes hold the name as textContent.
      if (eln instanceof HTMLElement) {
        const tx = normalizeAria(eln.textContent || "");
        if (
          tx.length >= 3 &&
          tx.length <= 60 &&
          !/^\d+$/.test(tx) &&
          !BAD_INLINE.test(tx) &&
          !BAD_GUIDE.test(tx) &&
          !looksLikeStarAria(tx)
        ) {
          const cand = splitAuthorFromCombinedAuthorText(tx);
          if (cand && isValidAuthorName(cand)) return cand;
        }
      }
      const kids = eln.childNodes;
      const limit = Math.min(kids.length, 120);
      for (let i = 0; i < limit; i++) {
        const hit = walk(kids[i]);
        if (hit) return hit;
      }
      return "";
    }

    const hit = walk(card);
    if (hit) row.author = hit;
  }

  /** @type {string | undefined} */
  let ratingVal = undefined;
  const starsEl =
    deepQueryScoped(card, sel().starsBlock)[0] || card.querySelector(sel().starsBlock);
  if (starsEl instanceof Element) {
    const rr = normalizeRatingText(starsEl.getAttribute("aria-label") || starsEl.textContent || "");
    if (rr) ratingVal = rr;
  }

  if (!ratingVal) {
    const { lines: lnB } = reviewBlockLines(card, textEl);
    for (const ln of lnB) {
      const rr = normalizeRatingText(ln);
      if (!rr) continue;
      ratingVal = rr;
      break;
    }
  }

  const timeEl =
    deepQueryScoped(card, sel().timeRelative)[0] || card.querySelector(sel().timeRelative);
  if (timeEl) {
    const t = normalizeAria(timeEl.textContent || "");
    if (t) {
      row.time = parseRelativeTimeToApproximateIso(t, Date.now());
    }
  }

  for (const a of deepQueryScoped(card, sel().reviewerProfileLink)) {
    if (!(a instanceof HTMLAnchorElement)) continue;
    let h = a.href || "";
    if (!h) continue;
    if (!/contrib|\/maps\/contrib\//i.test(h)) continue;
    try {
      const u = new URL(h);
      row.reviewerProfileUrl = `${u.origin}${u.pathname}`;
    } catch {
      row.reviewerProfileUrl = h.split("?")[0];
    }
    break;
  }

  /** Photo count from thumbnail buttons; overflow ("+ N ...") adds hidden amount. */
  const photoBtns = [...deepQueryScoped(card, sel().reviewPhotoButtons), ...card.querySelectorAll(sel().reviewPhotoButtons)];
  if (photoBtns.length > 0) {
    let visibleCount = 0;
    let overflowCount = 0;
    for (const btn of photoBtns) {
      if (!(btn instanceof HTMLElement)) continue;
      const label = normalizeAria(btn.getAttribute("aria-label") || btn.textContent || "");
      if (!label) {
        visibleCount += 1;
        continue;
      }
      if (/^\+/.test(label)) {
        const m = label.match(/\+\s*([\d.,]+)/);
        if (m) {
          const n = Number(m[1].replace(/[.,]/g, ""));
          if (Number.isFinite(n) && n > 0) overflowCount += n;
        }
        continue;
      }
      visibleCount += 1;
    }
    const total = visibleCount + overflowCount;
    if (total > 0) row.photoCount = total;
  }

  const imgs = deepQueryScoped(card, sel().reviewPhotoImages);
  const srcSeen = new Set();
  for (const im of imgs) {
    if (!(im instanceof HTMLImageElement)) continue;
    const s = im.currentSrc || im.src || im.getAttribute("data-src") || "";
    if (!s || !/^https?:/i.test(s)) continue;
    srcSeen.add(s.split("?")[0]);
  }
  if (row.photoCount === undefined && srcSeen.size > 0) row.photoCount = srcSeen.size;

  const { lines, mainTextLines } = reviewBlockLines(card, textEl);
  row.ownerReply = extractOwnerReplyText(lines, mainTextLines);

  const tuplesAllRaw = extractKeyValueTuples(
    lines,
    row.author || "",
    mainTextLines,
    row.ownerReply,
    reviewTextNorm.slice(0, 20)
  );
  const tuplesAll = inlineAspectTuples?.length ? [...inlineAspectTuples, ...tuplesAllRaw] : tuplesAllRaw;

  row.placeDetails = tuplesAll.some((t) => !isAspectLabelValueTuple(t))
    ? tuplesAll.filter((t) => !isAspectLabelValueTuple(t))
    : undefined;

  const ariaAspects = [
    ...(starsEl instanceof Element ? extractAriaLabeledStars(card, starsEl) : extractAriaLabeledStars(card, null)),
    ...extractAspectTuplesFromCardInnerText(card),
  ];
  const overallForAspectFilter = ratingVal || "";
  const aspectsMerged =
    tuplesAll.length || ariaAspects.length
      ? mergeAspectTuples(tuplesAll, ariaAspects, overallForAspectFilter)
      : [];
  if (!ratingVal && aspectsMerged.length && aspectsMerged[0].ratingText) {
    ratingVal = `${aspectsMerged[0].ratingText} bintang`;
  }
  if (ratingVal) row.rating = ratingVal;

  row.aspectRatings = aspectsMerged.length ? aspectsMerged : undefined;

  if (!row.aspectRatings) delete row.aspectRatings;
  if (!row.placeDetails) delete row.placeDetails;
  if (!row.ownerReply) delete row.ownerReply;
  if (!row.reviewId) delete row.reviewId;
  if (!row.time) delete row.time;
  if (row.photoCount === undefined || row.photoCount === 0) delete row.photoCount;
  if (!row.reviewerProfileUrl) delete row.reviewerProfileUrl;

  const result = row;

  if (result.author !== undefined) {
    const _a = String(result.author).trim();
    if (_a.length < 3 || /^\d+$/.test(_a)) delete result.author;
  }

  return result;
}

function extractReviews(scope, heading) {
  /** @type {HTMLElement[]} */
  const hosts = [];
  for (const el of deepQueryScoped(scope, sel().reviewExtractPrimary)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!composedContains(scope, el)) continue;
    if (heading && !nodeFollowsHeading(heading, el)) continue;
    hosts.push(el);
  }

  if (!hosts.length) {
    for (const el of deepQueryScoped(scope, sel().dataReviewId)) {
      if (!(el instanceof HTMLElement)) continue;
      if (!composedContains(scope, el)) continue;
      if (heading && !nodeFollowsHeading(heading, el)) continue;
      const root = el.closest("div") || el;
      if (root instanceof HTMLElement) hosts.push(root);
    }
  }

  if (!hosts.length) {
    /** Fallback when Maps renames `.MyEned` */
    for (const span of deepQueryScoped(scope, sel().reviewExtractSpans)) {
      if (!(span instanceof HTMLElement)) continue;
      const root = span.closest("div") || span.parentElement;
      if (!(root instanceof HTMLElement)) continue;
      if (!composedContains(scope, root)) continue;
      if (heading && !nodeFollowsHeading(heading, root)) continue;
      const t = normalizeAria(span.textContent || "");
      if (t.length < 10) continue;
      hosts.push(root);
    }
  }

  if (!hosts.length) {
    /** Last resort: DOM order can differ from visual order */
    for (const el of deepQueryScoped(scope, sel().reviewExtractPrimary)) {
      if (!(el instanceof HTMLElement)) continue;
      if (!composedContains(scope, el)) continue;
      hosts.push(el);
    }
  }

  /** @type {ScrapedReview[]} */
  const rows = [];
  const seen = new Set();

  const dedupHosts = [...new Set(hosts)];
  for (const host of dedupHosts) {
    const r = extractFromBlock(host);
    if (!r.text || r.text.length < 10) continue;
    const key =
      r.reviewId !== undefined && r.reviewId !== null && String(r.reviewId).trim() !== ""
        ? `id:${String(r.reviewId)}`
        : `${r.author || ""}::${r.text.slice(0, 480)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }

  rows.sort((a, b) => b.text.length - a.text.length);
  return rows;
}

/**
 * Persist scrape state to extension storage.
 * @returns {Promise<boolean>} false when Chrome invalidated the extension (reload/update/tab kept open).
 */
async function persistState(partial) {
  try {
    const prev = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        ...prev,
        ...partial,
        updatedAt: Date.now(),
      },
    });
    return true;
  } catch (e) {
    const msg = e && typeof e.message === "string" ? e.message : String(e || "");
    if (msg.includes("Extension context invalidated") || msg.includes("context invalidated")) {
      stopRequested = true;
    }
    return false;
  }
}

async function runJob(maxReviews = null) {
  await mergeSelectorsFromStorage();
  stopRequested = false;
  /** @type {ScrapedReview[]} */
  let reviews = [];

  /** @type {{ expandClicks: number, moreReviewClicks: number, scrollSteps: number, lazyHeightGrows?: number }} */
  const progress = { expandClicks: 0, moreReviewClicks: 0, scrollSteps: 0, lazyHeightGrows: 0 };

  if (
    !(await persistState({
      status: "running",
      reviews: [],
      progress,
      placeUrl: location.href,
      note: "",
      maxReviews: typeof maxReviews === "number" && Number.isFinite(maxReviews) ? maxReviews : null,
    }))
  ) {
    return;
  }

  await sleep(200);

  let heading = await ensureReviewsHeadingVisible();

  let scope = resolveReviewsScope(heading);

  if (!(heading instanceof HTMLElement) && !documentHasReviewSignals()) {
    await sleep(1200);
    heading = findReviewsHeading();
    scope = resolveReviewsScope(heading);
  }

  if (!(heading instanceof HTMLElement) && !documentHasReviewSignals()) {
    void persistState({
      status: "error",
      error:
        "Could not find the reviews section heading on this panel. Open a place and scroll to Reviews first.",
      reviews: [],
      progress,
      placeUrl: location.href,
      note: "",
      maxReviews: typeof maxReviews === "number" && Number.isFinite(maxReviews) ? maxReviews : null,
    });
    return;
  }

  /** @returns {HTMLElement} */
  function rescopeFromDom() {
    const h = findReviewsHeading();
    const s = h ? resolveReviewsScope(h) : scope || inferScopeFromReviewBlocks();
    return s instanceof HTMLElement ? s : scope;
  }

  /**
   * Write `reviews` + `progress` to chrome.storage during a sweep — not only at sweep end —
   * so the popup counter updates while scrape runs (copy-to-clipboard is unrelated; done on `done`).
   * @param {boolean} forceWrite bypass same-length skip (after scroll bursts: count may stay 0 but list moved)
   * @returns {Promise<boolean>}
   */
  let lastPersistedReviewCount = -1;
  async function persistLiveProgress(forceWrite = false) {
    if (stopRequested) return true;
    scope = rescopeFromDom();
    scrollEl = resolveScrollEl(scope, heading) || scrollEl;
    const snap = extractReviews(scope, heading);
    reviews = hasLimit ? snap.slice(0, maxReviews) : snap;
    const n = reviews.length;
    if (!forceWrite && n === lastPersistedReviewCount) return true;
    if (DEBUG_MODE) {
      fetch("http://127.0.0.1:7242/ingest/176c0b85-d0c0-41ef-a970-2527232dc552", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "0fdb9b",
        },
        body: JSON.stringify({
          sessionId: "0fdb9b",
          runId: "idle-stop-debug",
          hypothesisId: "H_RT",
          location: "content.js:persistLiveProgress",
          message: "persist_live_progress",
          data: {
            forceWrite,
            reviewsLen: n,
            prevReviewsLen: lastPersistedReviewCount,
            scrollSteps: progress.scrollSteps,
            lazyHeightGrows: progress.lazyHeightGrows || 0,
            scrollTop: scrollEl instanceof HTMLElement ? scrollEl.scrollTop : null,
            scrollHeight: scrollEl instanceof HTMLElement ? scrollEl.scrollHeight : null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    }
    lastPersistedReviewCount = n;
    return persistState({ reviews, progress });
  }

  /** @type {HTMLElement | null} */
  let scrollEl = resolveScrollEl(scope, heading);
  let lastSig = "";
  const hasLimit = typeof maxReviews === "number" && Number.isFinite(maxReviews) && maxReviews > 0;

  function limitReached() {
    return hasLimit && reviews.length >= maxReviews;
  }

  /** @returns {Promise<boolean>} */
  async function sweepOnce(sweepIdx) {
    if (stopRequested) return false;
    let changed = false;
    scope = rescopeFromDom();
    scrollEl = resolveScrollEl(scope, heading);

    /** 1) Lazy-load: snap to bottom + bounce until list height stabilizes */
    /** @type {boolean} */
    let grew1 = false;
    if (scrollEl instanceof HTMLElement && !stopRequested) {
      grew1 = await scrollBurstLoad(scrollEl, progress, { maxRounds: 12, stableExit: 4 });
      if (grew1) changed = true;
    }

    scope = rescopeFromDom();
    if (!(await persistLiveProgress(true))) return false;

    /** 2) Paginated batch buttons (may appear after scroll) */
    for (let m = 0; m < 3 && !stopRequested; m++) {
      const moreBtns = queryMoreReviewsButtons(scope);
      if (!moreBtns.length) break;
      const btn = moreBtns[0];
      try {
        await gentleClick(btn);
        progress.moreReviewClicks += 1;
        changed = true;
        await sleep(920);
        scope = rescopeFromDom();
        scrollEl = resolveScrollEl(scope, heading) || scrollEl;
      } catch {
        break;
      }
    }

    scope = rescopeFromDom();
    if (!(await persistLiveProgress(true))) return false;

    /** 3) Scroll again so newly injected reviews mount */
    /** @type {boolean} */
    let grew2 = false;
    if (scrollEl instanceof HTMLElement && !stopRequested) {
      grew2 = await scrollBurstLoad(scrollEl, progress, { maxRounds: 8, stableExit: 3 });
      if (grew2) changed = true;
    }

    scope = rescopeFromDom();
    if (!(await persistLiveProgress(true))) return false;

    /** 4) Expand truncated review text */
    const expanders = sortByViewportBottomDesc(queryExpandReviewTargets(scope));
    const expanderCount = expanders.length;

    if (DEBUG_MODE && typeof sweepIdx === "number" && sweepIdx < 14) {
      const jsRaw = deepQueryScoped(scope, sel().expandReviewJsaction).length;
      let jsVisibleEligible = 0;
      for (const b of deepQueryScoped(scope, sel().expandReviewJsaction)) {
        if (
          !(b instanceof HTMLButtonElement) ||
          !isElementBasicallyVisible(b) ||
          b.disabled ||
          b.getAttribute("aria-expanded") === "true"
        ) {
          continue;
        }
        jsVisibleEligible += 1;
      }
      let ariaFalseVisible = 0;
      for (const b of deepQueryScoped(scope, sel().ariaExpandedFalse)) {
        if (!(b instanceof HTMLElement) || !isElementBasicallyVisible(b)) continue;
        if (b instanceof HTMLButtonElement && b.disabled) continue;
        ariaFalseVisible += 1;
      }
      let lainnyaOnButton = 0;
      let lainnyaDivRoleBtn = 0;
      const seen = new Set();
      for (const el of deepQueryScoped(scope, sel().allButtons)) {
        if (!(el instanceof HTMLElement) || seen.has(el)) continue;
        if (!isElementBasicallyVisible(el)) continue;
        const blob =
          normalizeAria(el.getAttribute("aria-label") || "") +
          "\n" +
          normalizeAria(el.innerText || el.textContent || "");
        if (!matchesAny(EXPAND_TRUNCATED_LABEL, blob)) continue;
        seen.add(el);
        lainnyaOnButton += 1;
      }
      for (const el of deepQueryScoped(scope, sel().roleButtonVirtual)) {
        if (!(el instanceof HTMLElement)) continue;
        if (!isElementBasicallyVisible(el)) continue;
        const blob =
          normalizeAria(el.getAttribute("aria-label") || "") +
          "\n" +
          normalizeAria(el.innerText || el.textContent || "");
        if (!matchesAny(EXPAND_TRUNCATED_LABEL, blob)) continue;
        lainnyaDivRoleBtn += 1;
      }
      __agentDbg(
        "sweep expand survey",
        sweepIdx <= 5 ? "H-A" : "H-B",
        {
          sweepIdx,
          jsRaw,
          jsVisibleEligible,
          ariaFalseVisible,
          expandersChosen: expanders.length,
          lainnyaOnButton,
          lainnyaDivRoleBtn,
          reviewsLen: reviews.length,
          hasLimit,
          limitTarget: maxReviews,
          progressExpandClicks: progress.expandClicks,
        },
        "content.js:sweepOnce"
      );
    }

    for (const btn of expanders.slice(0, 80)) {
      if (stopRequested) break;
      try {
        await gentleClick(btn);
        progress.expandClicks += 1;
        changed = true;
        await sleep(320);
        if (!(await persistLiveProgress(false))) return false;
      } catch {
        /* ignore single click failures */
      }
    }

    /** 5) Short bottom pass after expands (layout often grows) */
    /** @type {boolean} */
    let grew3 = false;
    if (scrollEl instanceof HTMLElement && !stopRequested) {
      grew3 = await scrollBurstLoad(scrollEl, progress, { maxRounds: 4, stableExit: 2 });
      if (grew3) changed = true;
    }

    scope = rescopeFromDom();
    reviews = extractReviews(scope, heading);
    if (hasLimit) {
      reviews = reviews.slice(0, maxReviews);
    }

    if (!(await persistState({ reviews, progress }))) {
      return false;
    }

    const sh = scrollEl instanceof HTMLElement ? scrollEl.scrollHeight : 0;
    /** `scrollSteps` changes every burst; excluding it avoids never reaching idle while list is stable */
    const sig = `${reviews.length}:${progress.expandClicks}:${progress.moreReviewClicks}:${progress.lazyHeightGrows || 0}:${sh}`;
    if (DEBUG_MODE) {
      const wouldIdleExit = Boolean(!changed && sig === lastSig);
      const noisy = sweepIdx <= 40 || sweepIdx % 12 === 0 || wouldIdleExit;
      if (noisy) {
        fetch(
          "http://127.0.0.1:7242/ingest/176c0b85-d0c0-41ef-a970-2527232dc552",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "0fdb9b",
            },
            body: JSON.stringify({
              sessionId: "0fdb9b",
              runId: "idle-stop-debug",
              hypothesisId: "H_IDLE",
              location: "content.js:sweepOnce",
              message: "sweep_once_sig",
              data: {
                sweepIdx,
                changed,
                wouldIdleExit,
                sigEq: sig === lastSig,
                grew1,
                grew2,
                grew3,
                reviewsLen: reviews.length,
                expandClicks: progress.expandClicks,
                moreClicks: progress.moreReviewClicks,
                lh: progress.lazyHeightGrows || 0,
                sh,
                shBucket: typeof sh === "number" ? Math.round(sh / 200) : sh,
                lastSigLen: lastSig.length,
                expanderCount,
              },
              timestamp: Date.now(),
            }),
          }
        ).catch(() => {});
      }
    }
    if (!changed && sig === lastSig) return false;
    lastSig = sig;
    return true;
  }

  let idlePasses = 0;
  const maxIterations = 1200;
  /** @type {string} */
  let exitReason = "unknown";
  // #region agent log
  __agentDbg(
    "runJob start limits",
    "H-D",
    { maxReviewsArg: maxReviews, hasLimit, willSlice: hasLimit },
    "content.js:runJob"
  );
  // #endregion

  for (let i = 0; i < maxIterations && !stopRequested; i++) {
    const moved = await sweepOnce(i);
    if (stopRequested) {
      exitReason = "stopRequested";
      break;
    }
    if (!moved) idlePasses += 1;
    else idlePasses = 0;

    if (limitReached()) {
      exitReason = "limitReached";
      break;
    }

    if (idlePasses >= 3) {
      exitReason = "idle3";
      break;
    }

    await sleep(140);

    scope = rescopeFromDom();
    scrollEl = resolveScrollEl(scope, heading) || scrollEl;
  }

  if (stopRequested && exitReason === "unknown") exitReason = "stop";
  if (!stopRequested && exitReason === "unknown") exitReason = "unknown_postLoop";

  // #region agent log
  __agentDbg(
    "runJob exit",
    "H-C",
    {
      exitReason,
      idlePassesFinal: idlePasses,
      reviewsLen: extractReviews(rescopeFromDom(), heading).length,
      hasLimit,
      limitTarget: maxReviews,
      expandClicksFinal: progress.expandClicks,
      moreReviewClicksFinal: progress.moreReviewClicks,
      stopRequested,
    },
    "content.js:runJob"
  );
  // #endregion

  reviews = extractReviews(rescopeFromDom(), heading);
  if (hasLimit) {
    reviews = reviews.slice(0, maxReviews);
  }

  void persistState({
    status: stopRequested ? "stopped" : "done",
    reviews,
    progress,
    placeUrl: location.href,
    completedAt: Date.now(),
    note: stopRequested ? "Stopped by user." : "",
    maxReviews: typeof maxReviews === "number" && Number.isFinite(maxReviews) ? maxReviews : null,
  });
}

/**
 * If the extension reloads mid-scrape, `status: running` can persist with no further writes.
 * Flip to a visible error when `updatedAt` is older than this threshold.
 */
const STALE_RUNNING_MS = 3 * 60 * 1000;
void (async function recoverStaleRunningOnInject() {
  try {
    await mergeSelectorsFromStorage();
    const bag = await chrome.storage.local.get(STORAGE_KEY);
    const run = bag[STORAGE_KEY];
    if (!run || run.status !== "running") return;
    const t = typeof run.updatedAt === "number" ? run.updatedAt : 0;
    if (Date.now() - t < STALE_RUNNING_MS) return;
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        ...run,
        status: "error",
        error:
          "Previous scrape stopped responding (extension reloaded or the tab went idle). Refresh this Maps tab and start again.",
        updatedAt: Date.now(),
      },
    });
  } catch (_e) {
    /* ignore */
  }
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GMAPS_REVIEWS_START") {
    if (runnerPromise) {
      sendResponse?.({ ok: false, busy: true });
      return undefined;
    }
    stopRequested = false;
    try {
      void chrome.storage.local.remove([STOP_SIGNAL_KEY]);
    } catch {
      /* ignore */
    }
    const maxReviews =
      typeof msg?.maxReviews === "number" && Number.isFinite(msg.maxReviews) && msg.maxReviews > 0
        ? Math.floor(msg.maxReviews)
        : null;
    // #region agent log
    __agentDbg(
      "START message",
      "H-D",
      { rawMaxReviews: msg?.maxReviews, normalizedFloor: maxReviews },
      "content.js:onMessage"
    );
    // #endregion
    runnerPromise = runJob(maxReviews).finally(() => {
      runnerPromise = null;
    });
    sendResponse?.({ ok: true });
    return undefined;
  }
  if (msg?.type === "GMAPS_REVIEWS_STOP") {
    if (runnerPromise) stopRequested = true;
    sendResponse?.({ ok: true });
    return undefined;
  }
  return undefined;
});
