const STORAGE_KEY = "gmapsReviewsScraperLastRun";
const STOP_SIGNAL_KEY = "gmapsReviewsScraperStopSignal";
/** Persisted UI language: `"en"` | `"id"`. Unset defaults to English. */
const LANG_STORAGE_KEY = "gmapsPopupUiLang";
/** Match content.js: stale `running` → error so the UI is never stuck silent. */
const STALE_RUNNING_MS = 3 * 60 * 1000;

const COPY_SUCCESS = "ok";
const COPY_FAILED = "failed";

const ETH_WALLET_ADDRESS = "0xe4F6c89573218C4d46B2844fEBC2Fd039344Bc22";
const SOL_WALLET_ADDRESS = "GQFz83AT4fN5qpQCvN2mBEby6ibfJMaSuti7jP1bVX1s";
/** Native SegWit Taproot (P2TR) — bc1p… addresses */
const BTC_WALLET_ADDRESS =
  "bc1pvjt4r94jzaqqkdcaxnsewas4ytp44g8ejunycpyvs8slhfp0pzhsnwgj2a";

const i18n = {
  en: {
    title: "gmaps scraper",
    tutorialTitle: "Tutorial Analisa Data Review Gmaps",
    statusIdle: "Idle. Ready to collect reviews.",
    statusNoTab: "No active tab.",
    statusCantReach:
      "Could not reach this page. Reload the Maps tab after installing the extension, then try again.",
    statusRunning: "Processing reviews...",
    statusLastResult: "Last scrape: {count} reviews.",
    statusStopped: "Stopped. Reviews collected: {count}",
    statusError: "Error: {error}",
    statusCopiedManual: "Copied JSON to clipboard.",
    statusCopyFailedManual: "Copy failed. Try Download CSV.",
    statusPromptCopied: "Tutorial prompt copied.",
    statusPromptCopyFailed: "Prompt copy failed.",
    tutorialPrompt: "Extract the data and make it into spreadsheet.",
    slides: [
      {
        title: "Step 1 - Open Google Maps place",
        desc:
          "Open Google Maps and open your target place so the Reviews section is visible.\n\nIf scraping has reached the very bottom, <strong><u>please stop manually using the Stop button.</u></strong>",
      },
      {
        title: "Step 2 - Open Gemini or Claude",
        desc:
          "Use the copy icon to copy the prompt, then paste your review JSON and run the analysis.\n\nFor stronger insights, combine datasets from more than one place so you can compare rating trends, sentiment, and service quality between locations.",
      },
    ],
    btnStart: "Start collecting",
    btnStop: "Stop",
    btnCopy: "Copy JSON",
    reviewLimitLabel: "Collect target:",
    reviewLimit50: "50 reviews",
    reviewLimit100: "100 reviews",
    reviewLimitCustom: "Custom…",
    reviewLimitAll: "All reviews",
    reviewLimitCustomFieldLabel: "Exact count:",
    reviewLimitInvalidCustom: "Enter a whole number ≥ 1.",
    btnCsv: "Download CSV",
    manualStopWarning:
      "If collecting already reached the bottom and does not stop automatically, <strong>please press Stop manually.</strong>",
    walletCopyBtn: "Copy",
    walletKindEth: "ETH",
    walletKindSol: "SOL",
    walletKindBtcTaproot: "BTC",
    walletCopyAriaEth: "Copy Ethereum address",
    walletCopyAriaSol: "Copy Solana address",
    walletCopyAriaBtc: "Copy Bitcoin Taproot address",
    statusWalletCopied: "Address copied.",
    statusWalletCopyFailed: "Could not copy.",
  },
  id: {
    title: "gmaps scraper",
    tutorialTitle: "Tutorial Analisa Data Review Gmaps",
    statusIdle: "Siap. Tinggal mulai collect ulasan.",
    statusNoTab: "Tidak ada tab aktif.",
    statusCantReach:
      "Tidak bisa mengakses halaman ini. Reload tab Maps setelah install extension, lalu coba lagi.",
    statusRunning: "Sedang memproses ulasan...",
    statusLastResult: "Hasil terakhir: {count} ulasan.",
    statusStopped: "Dihentikan. Ulasan terkumpul: {count}",
    statusError: "Error: {error}",
    statusCopiedManual: "JSON berhasil disalin ke clipboard.",
    statusCopyFailedManual: "Gagal copy. Coba Unduh CSV.",
    statusPromptCopied: "Prompt tutorial berhasil disalin.",
    statusPromptCopyFailed: "Gagal menyalin prompt.",
    tutorialPrompt: "Extract the data and make it into spreadsheet.",
    slides: [
      {
        title: "Langkah 1 - Buka tempat di Google Maps",
        desc:
          "Buka Google Maps lalu buka target tempat sampai bagian Ulasan terlihat.\n\nJika scraping sudah mencapai bagian paling bawah, <strong><u>hentikan manual dengan tombol Stop.</u></strong>",
      },
      {
        title: "Langkah 2 - Buka Gemini atau Claude",
        desc:
          "Gunakan ikon copy untuk menyalin prompt, lalu tempel JSON review dan jalankan analisis.\n\nUntuk insight yang lebih kuat, gabungkan dataset dari lebih dari satu tempat agar bisa membandingkan tren rating, sentimen, dan kualitas layanan antar lokasi.",
      },
    ],
    btnStart: "Mulai collecting",
    btnStop: "Stop",
    btnCopy: "Copy JSON",
    reviewLimitLabel: "Target pengambilan:",
    reviewLimit50: "50 ulasan",
    reviewLimit100: "100 ulasan",
    reviewLimitCustom: "Kustom…",
    reviewLimitAll: "Semua ulasan",
    reviewLimitCustomFieldLabel: "Jumlah:",
    reviewLimitInvalidCustom: "Isi bilangan bulat ≥ 1.",
    btnCsv: "Unduh CSV",
    manualStopWarning:
      "Jika collecting sudah sampai paling bawah dan belum berhenti otomatis, <strong>harap tekan Stop manual.</strong>",
    walletCopyBtn: "Copy",
    walletKindEth: "ETH",
    walletKindSol: "SOL",
    walletKindBtcTaproot: "BTC",
    walletCopyAriaEth: "Salin alamat Ethereum",
    walletCopyAriaSol: "Salin alamat Solana",
    walletCopyAriaBtc: "Salin alamat Bitcoin Taproot",
    statusWalletCopied: "Alamat disalin.",
    statusWalletCopyFailed: "Gagal menyalin.",
  },
};

let currentLang = "en";
let lastDoneStamp = null;
let lastStatusText = "";
let currentSlideIdx = 0; // 0..(slides.length-1)
let lastRun = null;
/** Auto-copy state scoped to avoid accidental cross-handler mutation. */
const scrapeUi = Object.seal({ autoCopyPending: false });

const CUSTOM_REVIEW_MAX = 100000;

function syncReviewLimitCustomRow() {
  const sel = document.getElementById("review-limit");
  const row = document.getElementById("review-limit-custom-row");
  if (!sel || !row) return;
  row.hidden = sel.value !== "custom";
}

/**
 * Resolve maxReviews for GMAPS_REVIEWS_START: `null` = all reviews.
 * @returns {{ ok: true, maxReviews: number | null } | { ok: false }}
 */
function resolveStartMaxReviews() {
  const selected = document.getElementById("review-limit")?.value || "all";
  if (selected === "all") return { ok: true, maxReviews: null };
  if (selected === "custom") {
    const raw = document.getElementById("review-limit-custom")?.value?.trim() || "";
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return { ok: false };
    return { ok: true, maxReviews: Math.min(n, CUSTOM_REVIEW_MAX) };
  }
  const n = Number.parseInt(selected, 10);
  if (!Number.isFinite(n) || n < 1) return { ok: false };
  return { ok: true, maxReviews: n };
}

function tr(key, vars = {}) {
  let text = i18n[currentLang][key] || key;
  Object.keys(vars).forEach((k) => {
    text = text.replaceAll(`{${k}}`, String(vars[k]));
  });
  return text;
}

function setStatus(text) {
  lastStatusText = text;
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function setButtons({ running, hasResult }) {
  document.getElementById("start").disabled = running;
  document.getElementById("stop").disabled = !running;
  document.getElementById("copy").disabled = !hasResult;
  const csvEl = document.getElementById("csv");
  if (csvEl) csvEl.disabled = !hasResult;
}

function setProcessing(running) {
  const spinner = document.getElementById("processing-spinner");
  if (spinner) spinner.hidden = !running;
}

function setManualStopWarningVisible(visible) {
  const el = document.getElementById("manual-stop-warning");
  if (!el) return;
  el.hidden = !visible;
}

function clampSlide(idx) {
  const max = (i18n[currentLang]?.slides?.length || 1) - 1;
  return Math.max(0, Math.min(max, idx));
}

function renderSlide(run) {
  const slides = i18n[currentLang].slides;
  const slide = slides[currentSlideIdx];
  const titleEl = document.getElementById("slide-title");
  const descEl = document.getElementById("slide-desc");
  const counterEl = document.getElementById("slide-counter");
  const prevBtn = document.getElementById("slide-prev");
  const nextBtn = document.getElementById("slide-next");
  const linksEl = document.getElementById("slide-links");

  if (counterEl) counterEl.textContent = `${currentSlideIdx + 1} / ${slides.length}`;
  if (prevBtn) prevBtn.disabled = currentSlideIdx === 0;
  if (nextBtn) nextBtn.disabled = currentSlideIdx === slides.length - 1;

  if (titleEl) titleEl.textContent = slide?.title || "";

  let desc = slide?.desc || "";
  const showAiLinks = currentSlideIdx === 1;
  if (currentSlideIdx === 0 && run?.status === "running") {
    // Keep tutorial card height stable while running; status already shown in dedicated status row.
  }
  if (currentSlideIdx === 0 && run?.status === "error") {
    // Keep tutorial card static; error is rendered in status row.
  }
  if (currentSlideIdx === 0 && run?.status === "stopped") {
    // Keep tutorial card static; stopped info is rendered in status row.
  }
  if (descEl) {
    if (!showAiLinks) {
      descEl.innerHTML = desc.replaceAll("\n", "<br/>");
    } else {
      const parts = desc.split("\n\n");
      const intro = parts[0] || "";
      descEl.replaceChildren();

      const introEl = document.createElement("span");
      introEl.innerHTML = intro.replaceAll("\n", "<br/>");
      descEl.appendChild(introEl);

      const row = document.createElement("span");
      row.className = "inline-link-row";

      const prefix = document.createElement("span");
      prefix.textContent = currentLang === "id" ? "Buka" : "Open";

      const gemini = document.createElement("a");
      gemini.className = "inline-link";
      gemini.href = "https://gemini.google.com/app";
      gemini.target = "_blank";
      gemini.rel = "noopener noreferrer";
      gemini.setAttribute("aria-label", "Open Gemini");
      gemini.innerHTML =
        '<span class="ai-logo" aria-hidden="true"><img src="gemini-color.svg" alt="" width="18" height="18" /></span>Gemini';

      const join = document.createElement("span");
      join.className = "inline-link-join";
      join.textContent = currentLang === "id" ? "atau" : "or";

      const claude = document.createElement("a");
      claude.className = "inline-link";
      claude.href = "https://claude.ai/new";
      claude.target = "_blank";
      claude.rel = "noopener noreferrer";
      claude.setAttribute("aria-label", "Open Claude");
      claude.innerHTML =
        '<span class="ai-logo" aria-hidden="true"><img src="claude-color.svg" alt="" width="18" height="18" /></span>Claude';

      row.append(prefix, gemini, join, claude);
      descEl.appendChild(row);
    }
  }
  if (linksEl) {
    linksEl.replaceChildren();
    linksEl.classList.remove("two-col");
    if (currentSlideIdx === 0) {
      linksEl.appendChild(
        createLinkButton({
          href: "https://www.google.com/maps",
          label: "Google Maps",
          ariaLabel: "Open Google Maps",
          logoType: "gmaps",
        })
      );
    }
    if (showAiLinks) {
      const parts = desc.split("\n\n");
      const extra = parts.slice(1).join("\n\n");

      const wrap = document.createElement("div");
      wrap.className = "prompt-box";
      const promptInput = document.createElement("input");
      promptInput.type = "text";
      promptInput.className = "prompt-input";
      promptInput.readOnly = true;
      promptInput.value = tr("tutorialPrompt");
      promptInput.setAttribute("aria-label", "Tutorial prompt");

      const copyPromptBtn = document.createElement("button");
      copyPromptBtn.type = "button";
      copyPromptBtn.textContent = "📋";
      copyPromptBtn.title = "Copy prompt";
      copyPromptBtn.setAttribute("aria-label", "Copy prompt");
      copyPromptBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(promptInput.value);
          setStatus(tr("statusPromptCopied"));
        } catch {
          setStatus(tr("statusPromptCopyFailed"));
        }
      });
      wrap.append(promptInput, copyPromptBtn);
      linksEl.appendChild(wrap);

      if (extra) {
        const note = document.createElement("p");
        note.className = "slide-note";
        note.innerHTML = extra.replaceAll("\n", "<br/>");
        linksEl.appendChild(note);
      }
    }
  }
}

function createLinkButton({ href, label, ariaLabel, logoType }) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.setAttribute("aria-label", ariaLabel);

  const logo = document.createElement("span");
  logo.className = "ai-logo";
  logo.setAttribute("aria-hidden", "true");

  if (logoType === "claude") {
    const img = document.createElement("img");
    img.src = "claude-color.svg";
    img.alt = "";
    img.width = 18;
    img.height = 18;
    logo.appendChild(img);
  } else if (logoType === "gemini") {
    const img = document.createElement("img");
    img.src = "gemini-color.svg";
    img.alt = "";
    img.width = 18;
    img.height = 18;
    logo.appendChild(img);
  } else {
    const img = document.createElement("img");
    img.src = "google-color.svg";
    img.alt = "";
    img.width = 18;
    img.height = 18;
    logo.appendChild(img);
  }

  const text = document.createElement("span");
  text.textContent = label;
  a.append(logo, text);
  return a;
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.getElementById("title").textContent = tr("title");
  document.getElementById("tutorial-title").textContent = tr("tutorialTitle");
  document.getElementById("start").textContent = tr("btnStart");
  document.getElementById("stop").textContent = tr("btnStop");
  document.getElementById("copy").textContent = tr("btnCopy");
  const csvBtn = document.getElementById("csv");
  if (csvBtn) csvBtn.textContent = tr("btnCsv");
  const manualWarn = document.getElementById("manual-stop-warning");
  if (manualWarn) manualWarn.innerHTML = tr("manualStopWarning");
  const chEth = document.getElementById("crypto-chain-eth");
  if (chEth) chEth.textContent = tr("walletKindEth");
  const chSol = document.getElementById("crypto-chain-sol");
  if (chSol) chSol.textContent = tr("walletKindSol");
  const chBtc = document.getElementById("crypto-chain-btc");
  if (chBtc) chBtc.textContent = tr("walletKindBtcTaproot");

  const ethEl = document.getElementById("crypto-addr-eth");
  if (ethEl) ethEl.textContent = ETH_WALLET_ADDRESS;
  const solEl = document.getElementById("crypto-addr-sol");
  if (solEl) solEl.textContent = SOL_WALLET_ADDRESS;
  const btcEl = document.getElementById("crypto-addr-btc");
  if (btcEl) btcEl.textContent = BTC_WALLET_ADDRESS;

  /** @param {HTMLElement | null} btn */
  function wireWalletBtn(btn, addr, ariaKey) {
    if (!btn || !addr) return;
    btn.title = `${tr(ariaKey)} · ${addr}`;
    btn.setAttribute("aria-label", `${tr(ariaKey)} (${addr})`);
    const copyBtn = btn.querySelector(".crypto-copy-btn");
    if (copyBtn instanceof HTMLButtonElement) {
      copyBtn.dataset.walletAddress = addr;
      copyBtn.dataset.ariaKey = ariaKey;
      copyBtn.textContent = tr("walletCopyBtn");
      copyBtn.setAttribute("aria-label", tr(ariaKey));
      copyBtn.title = `${tr(ariaKey)} · ${addr}`;
    }
  }
  wireWalletBtn(document.getElementById("copy-eth-wallet"), ETH_WALLET_ADDRESS, "walletCopyAriaEth");
  wireWalletBtn(document.getElementById("copy-sol-wallet"), SOL_WALLET_ADDRESS, "walletCopyAriaSol");
  wireWalletBtn(document.getElementById("copy-btc-wallet"), BTC_WALLET_ADDRESS, "walletCopyAriaBtc");
  document.getElementById("review-limit-label").textContent = tr("reviewLimitLabel");
  const sel = document.getElementById("review-limit");
  if (sel && sel.options?.length >= 4) {
    sel.options[0].text = tr("reviewLimit50");
    sel.options[1].text = tr("reviewLimit100");
    sel.options[2].text = tr("reviewLimitCustom");
    sel.options[3].text = tr("reviewLimitAll");
  }
  const customLbl = document.getElementById("review-limit-custom-label");
  if (customLbl) customLbl.textContent = tr("reviewLimitCustomFieldLabel");
  syncReviewLimitCustomRow();
  document.getElementById("lang-en").classList.toggle("active", currentLang === "en");
  document.getElementById("lang-id").classList.toggle("active", currentLang === "id");
  renderSlide(lastRun);
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function tryCopyRun(run) {
  if (!run?.reviews?.length) return COPY_FAILED;
  try {
    await navigator.clipboard.writeText(JSON.stringify(buildExportRun(run), null, 2));
    return COPY_SUCCESS;
  } catch {
    return COPY_FAILED;
  }
}

function buildExportRun(run) {
  const reviews = (run?.reviews || []).map((r) => {
    if (!r || typeof r !== "object") return r;
    const out = { ...r };
    delete out.reviewId;
    delete out.meta;
    delete out.relativeTimeRaw;
    delete out.contributorSummary;
    delete out.postedAtApproximateIso;
    return out;
  });
  const out = { ...(run || {}), reviews };
  delete out.placeUrl;
  return out;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Flat table: one row per review for spreadsheets. */
function buildReviewsCsv(run) {
  const reviews = run?.reviews || [];
  const headers = [
    "text",
    "author",
    "rating",
    "aspectRatings_json",
    "time_raw",
    "time_iso",
    "time_edited",
    "photoCount",
    "reviewerProfileUrl",
    "ownerReply",
  ];
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of reviews) {
    const t = r.time && typeof r.time === "object" ? r.time : null;
    lines.push(
      [
        r.text,
        r.author,
        r.rating,
        r.aspectRatings !== undefined ? JSON.stringify(r.aspectRatings) : "",
        t?.raw,
        t?.iso,
        t?.edited ? "true" : "",
        r.photoCount,
        r.reviewerProfileUrl,
        r.ownerReply,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  /** BOM helps Excel recognize UTF-8 for non-ASCII review text */
  return "\uFEFF" + lines.join("\r\n");
}

/**
 * @param {object | null | undefined} run
 */
async function recoverStaleRunningIfNeeded(run) {
  if (!run || run.status !== "running") return run;
  const t = typeof run.updatedAt === "number" ? run.updatedAt : 0;
  if (Date.now() - t < STALE_RUNNING_MS) return run;
  const fixed = {
    ...run,
    status: "error",
    error:
      "Previous scrape lost connection (extension reloaded or the Maps tab went idle). Refresh Maps and start again.",
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: fixed });
  return fixed;
}

async function refreshFromStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  let run = data[STORAGE_KEY];
  run = await recoverStaleRunningIfNeeded(run);
  lastRun = run || null;
  if (!run) {
    setStatus(tr("statusIdle"));
    setButtons({ running: false, hasResult: false });
    setProcessing(false);
    setManualStopWarningVisible(false);
    renderSlide(null);
    return;
  }

  if (run.status === "running") {
    setStatus(tr("statusRunning"));
    setButtons({ running: true, hasResult: (run.reviews?.length ?? 0) > 0 });
    setProcessing(true);
    setManualStopWarningVisible(true);
    renderSlide(run);
    return;
  }

  if (run.status === "done") {
    setProcessing(false);
    setManualStopWarningVisible(false);
    setButtons({ running: false, hasResult: (run.reviews?.length ?? 0) > 0 });
    renderSlide(run);

    const stamp = String(run.completedAt || run.updatedAt || run.reviews?.length || "");
    const count = run.reviews?.length ?? 0;
    if (stamp && stamp !== lastDoneStamp) {
      lastDoneStamp = stamp;
      if (scrapeUi.autoCopyPending) {
        scrapeUi.autoCopyPending = false;
        const copied = await tryCopyRun(run);
        void copied;
      } else {
        /* no-op */
      }
      setStatus(tr("statusLastResult", { count }));
      renderSlide(run);
      return;
    }

    if (!lastStatusText) {
      setStatus(tr("statusLastResult", { count }));
    }
    renderSlide(run);
    return;
  }

  if (run.status === "error") {
    setProcessing(false);
    setManualStopWarningVisible(false);
    setStatus(tr("statusError", { error: run.error || "Unknown" }));
    setButtons({ running: false, hasResult: false });
    renderSlide(run);
    return;
  }

  if (run.status === "stopped") {
    setProcessing(false);
    setManualStopWarningVisible(false);
    setStatus(tr("statusStopped", { count: run.reviews?.length ?? 0 }));
    setButtons({ running: false, hasResult: (run.reviews?.length ?? 0) > 0 });
    renderSlide(run);
    return;
  }

  setProcessing(false);
  setManualStopWarningVisible(false);
  setStatus(tr("statusIdle"));
  setButtons({ running: false, hasResult: false });
  renderSlide(run);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY]) {
    refreshFromStorage();
  }
});

document.getElementById("lang-en").addEventListener("click", () => {
  currentLang = "en";
  void chrome.storage.local.set({ [LANG_STORAGE_KEY]: "en" });
  applyLanguage();
  refreshFromStorage();
});

document.getElementById("lang-id").addEventListener("click", () => {
  currentLang = "id";
  void chrome.storage.local.set({ [LANG_STORAGE_KEY]: "id" });
  applyLanguage();
  refreshFromStorage();
});

document.getElementById("slide-prev").addEventListener("click", () => {
  currentSlideIdx = clampSlide(currentSlideIdx - 1);
  renderSlide(lastRun);
});

document.getElementById("slide-next").addEventListener("click", () => {
  currentSlideIdx = clampSlide(currentSlideIdx + 1);
  renderSlide(lastRun);
});

document.getElementById("wallet-stack")?.addEventListener("click", async (e) => {
  const btn = e.target.closest(".crypto-copy-btn[data-wallet-address]");
  if (!btn) return;
  const addr = btn.getAttribute("data-wallet-address");
  if (!addr) return;
  try {
    await navigator.clipboard.writeText(addr);
    setStatus(tr("statusWalletCopied"));
  } catch {
    setStatus(tr("statusWalletCopyFailed"));
  }
});

document.getElementById("wallet-toggle")?.addEventListener("click", () => {
  const stack = document.getElementById("wallet-stack");
  const toggle = document.getElementById("wallet-toggle");
  if (!(stack instanceof HTMLElement) || !(toggle instanceof HTMLElement)) return;
  const willOpen = stack.hidden;
  stack.hidden = !willOpen;
  toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
});

document.getElementById("review-limit").addEventListener("change", () => syncReviewLimitCustomRow());

document.getElementById("start").addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus(tr("statusNoTab"));
    return;
  }
  const resolved = resolveStartMaxReviews();
  if (!resolved.ok) {
    setStatus(tr("reviewLimitInvalidCustom"));
    syncReviewLimitCustomRow();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "GMAPS_REVIEWS_START", maxReviews: resolved.maxReviews });
  } catch {
    setStatus(tr("statusCantReach"));
    return;
  }
  scrapeUi.autoCopyPending = true;
  setStatus(tr("statusRunning"));
  setButtons({ running: true, hasResult: false });
  setProcessing(true);
  renderSlide(lastRun);
  void refreshFromStorage();
});

document.getElementById("stop").addEventListener("click", async () => {
  /** Any Maps tab with an active scrape sees this via `storage.onChanged` (avoids sendMessage-only failures). */
  try {
    await chrome.storage.local.set({ [STOP_SIGNAL_KEY]: Date.now() });
  } catch {
    /* ignore */
  }
  const tabId = await getActiveTabId();
  if (tabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "GMAPS_REVIEWS_STOP" });
    } catch {
      /* content may still stop from storage signal */
    }
  }
  await refreshFromStorage();
  setTimeout(() => void refreshFromStorage(), 200);
  setTimeout(() => void refreshFromStorage(), 650);
});

document.getElementById("copy").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const run = data[STORAGE_KEY];
  const copied = await tryCopyRun(run);
  if (copied === COPY_SUCCESS) {
    setStatus(tr("statusCopiedManual"));
  } else {
    setStatus(tr("statusCopyFailedManual"));
  }
});

document.getElementById("csv").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const run = data[STORAGE_KEY];
  if (!run?.reviews?.length) return;
  const csv = buildReviewsCsv(run);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `maps-reviews-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

applyLanguage();
void (async () => {
  try {
    const data = await chrome.storage.local.get(LANG_STORAGE_KEY);
    const saved = data[LANG_STORAGE_KEY];
    if ((saved === "en" || saved === "id") && saved !== currentLang) {
      currentLang = saved;
      applyLanguage();
    }
  } catch {
    /* ignore */
  }
  void refreshFromStorage();
})();
