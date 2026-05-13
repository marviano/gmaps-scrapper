/**
 * Centralized DOM selectors for Google Maps review UI.
 * Runtime copy: content.js resets `__GMAPS_SEL_ACTIVE` from these defaults each run.
 */
globalThis.__GMAPS_SEL = Object.freeze({
  /** Increment when bundled defaults change meaningfully */
  VERSION: 4,

  headingSelectors:
    'h2.kPvgOb.fontHeadlineSmall, h2[class*="fontHeadlineSmall"][class*="kPvgOb"], ' +
    "h2, [role=\"heading\"][aria-level=\"2\"], [role=\"heading\"]",

  compactLabelRoots: "span, div",

  tabSelected: '[role="tab"][aria-selected="true"]',
  tabButtonAnchor: '[role="tab"], button, a',

  /** Single query matching review-ish nodes inside a candidate scope */
  reviewHintsInScope:
    ".jJc9Ad, [class*='jJc9Ad'], .MyEned, [class*='MyEned'], [data-review-id], span.wiI7pd, [class*='wiI7pd']",

  reviewHostsPrimary: ".jJc9Ad, [class*='jJc9Ad'], .MyEned, [class*='MyEned'], [data-review-id]",
  dataReviewId: "[data-review-id]",
  reviewTextPrimary: "span.wiI7pd",
  reviewTextSpans: "span.wiI7pd, [class*='wiI7pd']",
  visibleReviewBlocksGlob:
    ".jJc9Ad, [class*='jJc9Ad'], .MyEned, [class*='MyEned'], [data-review-id], span.wiI7pd, [class*='wiI7pd']",

  reviewSignalsSelectors: "[data-review-id], button[jsaction*='expandReview']",

  sidebarScroller: '[role="main"] .m6QErb, .m6QErb',

  expandReviewJsaction: '[jsaction*="expandReview"]',
  expandReviewLainnya:
    'button[aria-label*="lainnya" i], [role="button"][aria-label*="lainnya" i], span[aria-label*="lainnya" i], ' +
    'button[aria-label*="more reviews" i], [role="button"][aria-label*="more reviews" i]',
  ariaExpandedFalse:
    'button[aria-expanded="false"], [role="button"][aria-expanded="false"]',
  allButtons: "button",
  roleButtonVirtual: '[role="button"]:not(button)',

  scrollPanel: ".m6QErb",
  scrollHintSelector:
    ".jJc9Ad, [class*='jJc9Ad'], .MyEned, [class*='MyEned'], span.wiI7pd, [class*='wiI7pd'], [data-review-id], button[jsaction*='expandReview']",

  imgWithAriaLabel: '[role="img"][aria-label]',
  spanAndDiv: "span, div",

  authorTitle: ".jftiEf.fontBodyMedium, .d4r55, [class*='d4r55']",
  starsBlock:
    'span.kvMYJc[aria-label], .kvMYJc[role="img"], [role="img"][aria-label*="star" i], [role="img"][aria-label*="bintang" i], [role="img"][aria-label*="Sterne" i], [aria-label*="star" i], [aria-label*="bintang" i], [aria-label*="Sterne" i]',
  contributorLine: '.NsCY4, .RfnDt, [class*="RfnDt"], span[class*="contributor" i]',
  timeRelative:
    ".DU9Pgb, .rsqaWe, [class*='rsqaWe'], [class*='timezone'], span[aria-label*='lalu' i], span[aria-label*='ago' i]",

  reviewExtractPrimary: ".jJc9Ad, [class*='jJc9Ad'], .MyEned, [class*='MyEned'], [data-review-id]",
  reviewExtractSpans: "span.wiI7pd, [class*='wiI7pd']",

  /** Contributor profile (Maps contrib URL) inside a review block */
  reviewerProfileLink: 'a[href*="contrib"], a[href*="maps/contrib/"], a[href*="/contrib/"]',
  /** Inline review photos (thumbnail images) */
  reviewPhotoImages: 'img[src*="googleusercontent"], img[src*="ggpht.com"], img[data-src*="googleusercontent"]',
  reviewPhotoButtons: "button.Tya61d",
});
