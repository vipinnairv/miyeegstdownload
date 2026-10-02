"use strict";

/*
 * GST Returns Bulk Downloader, page engine.
 *
 * Runs on gst.gov.in. Drives the Returns Dashboard form, waits for the AJAX
 * tile grid, then clicks the download control on the tile that matches the
 * requested return type.
 *
 * The portal is an AngularJS application, so plain value assignment and
 * element.click() are not enough. See setSelectValue() and realClick().
 */

(function () {

  /* Guard against double injection. The manifest declares this file as a
   * content script and the popup can also inject it with chrome.scripting. */
  if (window.__gstBulkDownloaderLoaded) {
    return;
  }
  window.__gstBulkDownloaderLoaded = true;

  /* ------------------------------------------------------------------ */
  /* Selectors                                                           */
  /* ------------------------------------------------------------------ */

  /*
   * Every portal specific selector and label lives here and nowhere else.
   * The GST portal changes its markup without notice, so treat all of these
   * as placeholders until you have confirmed each one in DevTools on the
   * live page. The README explains the one at a time verification routine.
   */
  var PORTAL_SELECTORS = {
    /* TODO placeholder: verify on the live portal. Container that only exists
     * on the Returns Dashboard search form. */
    dashboardRoot: "form[name='returnsDashboardForm'], div.rtnDashboard, div[ng-controller*='returns']",

    /* TODO placeholder: verify on the live portal. Financial Year select. */
    financialYearSelect: "select[name='fin'], select[ng-model='fin'], #fin",

    /* TODO placeholder: verify on the live portal. Quarter select, rendered
     * only for QRMP filers. */
    quarterSelect: "select[name='quarter'], select[ng-model='quarter'], #quarter",

    /* TODO placeholder: verify on the live portal. Period (month) select. */
    periodSelect: "select[name='mon'], select[ng-model='mon'], #mon",

    /* TODO placeholder: verify on the live portal. Search button under the
     * three dropdowns. */
    searchButton: "button.srch, button[data-ng-click*='search'], button[type='submit']",

    /* TODO placeholder: verify on the live portal. Wrapper around the grid of
     * return tiles rendered after Search. */
    tileGrid: "div.dashboardTiles, div.tabpane, div[class*='card-group']",

    /* TODO placeholder: verify on the live portal. A single return tile. The
     * portal reuses generic class names, so tiles are matched by their text,
     * never by index. */
    tileItem: "div.card, div.panel, div.tile",

    /* TODO placeholder: verify on the live portal. Element inside a tile that
     * carries the return name, for example GSTR1 or GSTR3B. */
    tileTitle: "div.card-header, h4, h5, .panel-heading",

    /* TODO placeholder: verify on the live portal. Any actionable button or
     * link inside a tile. Matched further by its own text. */
    tileActions: "button, a, input[type='button'], input[type='submit'], [role='button']",

    /* TODO placeholder: verify on the live portal. AJAX loading overlay or
     * spinner that covers the page during a request. */
    loadingOverlay: "div.loading, div.loader, div.modal-backdrop, .cdk-overlay-backdrop",

    /* TODO placeholder: verify on the live portal. Inline error or alert box
     * shown when a search returns nothing. */
    errorBanner: "div.alert-danger, div.err, span.err",

    /* TODO placeholder: verify on the live portal. On the offline download
     * screen, the button that generates or downloads the file. */
    offlineGenerateButton: "button[data-ng-click*='generate'], button.generateFile",

    /* TODO placeholder: verify on the live portal. Link exposed after the file
     * has been generated on the offline screen. */
    offlineDownloadLink: "a[data-ng-click*='download'], a.downloadLink, a[href*='download']",

    /* TODO placeholder: verify on the live portal. Back to dashboard control
     * on the offline download screen. */
    backToDashboard: "a[href*='returns/dashboard'], button.backBtn",

    /* Text matchers. TODO placeholder: confirm the exact wording on the live
     * portal, including case and spacing. */
    text: {
      gstr1Title: "GSTR-1",
      gstr1Aliases: ["GSTR-1", "GSTR1"],
      gstr1ExcludeAliases: ["GSTR-1A", "GSTR1A", "GSTR-1 IFF", "IFF"],
      gstr2bAliases: ["GSTR-2B", "GSTR2B"],
      gstr2bExcludeAliases: [],
      /* Portal wording when a file is still being built. */
      inProgress: ["IN PROGRESS", "COME BACK AFTER", "BEING GENERATED", "AFTER 20 MINUTES"],
      gstr3bTitle: "GSTR-3B",
      gstr3bAliases: ["GSTR-3B", "GSTR3B"],
      gstr3bExcludeAliases: [],
      /* Two tiers, tried in order. A tile that already has a generated file
       * shows Download; a tile that does not shows Prepare Offline instead,
       * which asks the portal to build the file first. Always prefer the
       * direct download and fall back only when it is absent. */
      downloadActions: ["DOWNLOAD"],
      /* Which tile button opens the file, per return. GSTR-1: VIEW, then
       * DOWNLOAD FILED (PDF) on the next page. GSTR-3B: DOWNLOAD directly. */
      tileButtonByReturn: {
        GSTR1: ["VIEW"],
        GSTR2B: ["DOWNLOAD"],
        GSTR3B: ["DOWNLOAD"]
      },
      /* Returns whose tile button downloads at once, with no detail page. */
      directDownload: ["GSTR3B"],
      prepareOfflineActions: ["PREPARE OFFLINE", "GENERATE", "GENERATE FILE"],
      noRecords: ["NO RECORDS FOUND", "NO DATA"],
      /* Second page, opened by the tile's DOWNLOAD button: the button that
       * actually produces the file. Seen on the live portal for GSTR-1. */
      detailActions: ["DOWNLOAD FILED (PDF)", "DOWNLOAD FILED", "GENERATE EXCEL FILE TO DOWNLOAD",
                      "GENERATE JSON FILE TO DOWNLOAD", "DOWNLOAD FILE"],
      backActions: ["BACK"]
    },

    /* Values the portal expects in its dropdowns. TODO placeholder: confirm
     * whether the Quarter option labels read "Quarter 1" or "Apr-Jun". */
    quarterLabels: {
      Q1: "Quarter 1",
      Q2: "Quarter 2",
      Q3: "Quarter 3",
      Q4: "Quarter 4"
    }
  };

  /* ------------------------------------------------------------------ */
  /* Constants and state                                                 */
  /* ------------------------------------------------------------------ */

  var MIN_DELAY = 3000;
  var DEFAULT_DELAY = 4000;
  var ABORT_TICK = 250;
  var WAIT_TIMEOUT = 30000;
  var IDLE_TIMEOUT = 30000;
  var FAILURE_COOLDOWN_MULTIPLIER = 2.5;
  /* Extra attempts allowed for a period that failed on a timeout only. */
  var TIMEOUT_RETRIES = 1;
  var STORAGE_KEY = "gstJobState";

  var QUARTER_OF_MONTH = {
    April: "Q1", May: "Q1", June: "Q1",
    July: "Q2", August: "Q2", September: "Q2",
    October: "Q3", November: "Q3", December: "Q3",
    January: "Q4", February: "Q4", March: "Q4"
  };

  var runtime = {
    state: null,
    busy: false,
    abort: false
  };

  /* ------------------------------------------------------------------ */
  /* Messaging helpers                                                   */
  /* ------------------------------------------------------------------ */

  /* The popup is often closed while a job runs, which makes sendMessage
   * reject with "Could not establish connection". Swallow that quietly. */
  function push(payload) {
    try {
      chrome.runtime.sendMessage(payload, function () {
        if (chrome.runtime.lastError) {
          /* No receiver. Expected whenever the popup is closed. */
          return;
        }
      });
    } catch (e) {
      /* Extension context can be invalidated on reload. Ignore. */
    }
  }

  function log(message, level) {
    push({ type: "JOB_EVENT", event: "log", message: message, level: level || "info" });
  }

  function progress(done, total) {
    push({ type: "JOB_EVENT", event: "progress", done: done, total: total });
  }

  /* ------------------------------------------------------------------ */
  /* Timing helpers                                                      */
  /* ------------------------------------------------------------------ */

  function AbortError(message) {
    var err = new Error(message || "Aborted by user");
    err.name = "AbortError";
    return err;
  }

  /* Tagged separately from other failures because a timeout is often just a
   * slow portal response and is worth one more attempt. */
  function TimeoutError(message) {
    var err = new Error(message);
    err.name = "TimeoutError";
    return err;
  }

  /*
   * Sleep in short ticks so a Stop press lands inside about 250ms instead of
   * after the full configured delay.
   */
  async function sleep(ms) {
    var remaining = ms;
    while (remaining > 0) {
      if (runtime.abort) {
        throw AbortError();
      }
      var chunk = remaining < ABORT_TICK ? remaining : ABORT_TICK;
      await new Promise(function (resolve) {
        setTimeout(resolve, chunk);
      });
      remaining -= chunk;
    }
    if (runtime.abort) {
      throw AbortError();
    }
  }

  function isVisible(node) {
    if (!node) {
      return false;
    }
    if (node.disabled) {
      return false;
    }
    var rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }
    var style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  /*
   * Poll for an element instead of guessing how long the AJAX call takes.
   * Returns the node or throws on timeout.
   */
  async function waitForElement(selector, options) {
    var opts = options || {};
    var timeout = opts.timeout || WAIT_TIMEOUT;
    var requireVisible = opts.visible !== false;
    var root = opts.root || document;
    var label = opts.label || selector;
    var deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (runtime.abort) {
        throw AbortError();
      }
      var nodes = root.querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i++) {
        if (!requireVisible || isVisible(nodes[i])) {
          return nodes[i];
        }
      }
      await sleep(ABORT_TICK);
    }
    throw TimeoutError("Timed out waiting for " + label);
  }

  /* Same as waitForElement but resolves to null instead of throwing. */
  async function waitForElementOptional(selector, options) {
    try {
      return await waitForElement(selector, options);
    } catch (e) {
      if (e && e.name === "AbortError") {
        throw e;
      }
      return null;
    }
  }

  /*
   * Wait until no loading overlay is visible and the DOM has stopped changing
   * for a short quiet window. Used after Search and after navigation.
   */
  async function waitForIdle(options) {
    var opts = options || {};
    var timeout = opts.timeout || IDLE_TIMEOUT;
    var quietFor = opts.quietFor || 700;
    var deadline = Date.now() + timeout;
    var lastMutation = Date.now();

    var observer = new MutationObserver(function () {
      lastMutation = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    try {
      while (Date.now() < deadline) {
        if (runtime.abort) {
          throw AbortError();
        }
        var overlay = document.querySelector(PORTAL_SELECTORS.loadingOverlay);
        var overlayBusy = overlay && isVisible(overlay);
        if (!overlayBusy && Date.now() - lastMutation >= quietFor) {
          return true;
        }
        await sleep(ABORT_TICK);
      }
      return false;
    } finally {
      observer.disconnect();
    }
  }

  /* ------------------------------------------------------------------ */
  /* AngularJS aware interaction helpers                                 */
  /* ------------------------------------------------------------------ */

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim().toUpperCase();
  }

  /*
   * Assigning select.value does not tell AngularJS that ng-model changed, so
   * dispatch both input and change with bubbles set.
   */
  function setSelectValue(select, wantedLabel) {
    var wanted = normalize(wantedLabel);
    var chosen = null;
    for (var i = 0; i < select.options.length; i++) {
      var opt = select.options[i];
      if (normalize(opt.textContent) === wanted || normalize(opt.value) === wanted) {
        chosen = opt;
        break;
      }
    }
    if (!chosen) {
      /* Fall back to a contains match, since the portal sometimes prefixes
       * option labels. */
      for (var j = 0; j < select.options.length; j++) {
        if (normalize(select.options[j].textContent).indexOf(wanted) !== -1) {
          chosen = select.options[j];
          break;
        }
      }
    }
    if (!chosen) {
      return false;
    }
    select.focus();
    select.value = chosen.value;
    select.selectedIndex = chosen.index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  /*
   * AngularJS listens for real mouse events on many controls, and
   * element.click() skips mousedown and mouseup entirely.
   */
  function realClick(node) {
    if (!node) {
      return false;
    }
    var rect = node.getBoundingClientRect();
    var base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0
    };
    try {
      node.scrollIntoView({ block: "center" });
    } catch (e) {
      /* Older layout engines. Ignore. */
    }
    node.dispatchEvent(new MouseEvent("mouseover", base));
    node.dispatchEvent(new MouseEvent("mousedown", base));
    node.dispatchEvent(new MouseEvent("mouseup", base));
    node.dispatchEvent(new MouseEvent("click", base));
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Tile matching                                                       */
  /* ------------------------------------------------------------------ */

  function tileMatchers(returnType) {
    var t = PORTAL_SELECTORS.text;
    if (returnType === "GSTR2B") {
      return { include: t.gstr2bAliases, exclude: t.gstr2bExcludeAliases };
    }
    if (returnType === "GSTR3B") {
      return { include: t.gstr3bAliases, exclude: t.gstr3bExcludeAliases };
    }
    return { include: t.gstr1Aliases, exclude: t.gstr1ExcludeAliases };
  }

  /*
   * Match tiles by their text, never by position. The exclude list keeps a
   * GSTR-1 request from landing on the GSTR-1A or IFF tile, whose titles both
   * contain the GSTR-1 substring.
   */
  /* Return codes named in a piece of text, e.g. "GSTR-1 ... GSTR-2B" gives
   * ["GSTR1", "GSTR2B"]. */
  function gstrCodes(text) {
    var found = normalize(text).match(/GSTR\s*-?\s*\d+[A-Z]?/g) || [];
    return found.map(function (s) { return s.replace(/[\s-]/g, ""); });
  }

  /*
   * Start from every visible control that could open the return, walk up to
   * the nearest ancestor that names any GSTR code (that is the control's own
   * tile), and keep it when that code is the one requested. No class names
   * or size guesses, so it survives portal markup changes.
   */
  function findReturnTile(returnType) {
    var wanted = returnType.replace(/[\s-]/g, "").toUpperCase();
    var nodes = document.querySelectorAll(PORTAL_SELECTORS.tileActions);
    for (var i = 0; i < nodes.length; i++) {
      if (!isVisible(nodes[i])) {
        continue;
      }
      var el = nodes[i].parentElement;
      while (el && el !== document.body && !gstrCodes(el.textContent).length) {
        el = el.parentElement;
      }
      if (!el || el === document.body) {
        continue;
      }
      if (gstrCodes(el.textContent).indexOf(wanted) !== -1 && findTileAction(el, returnType)) {
        return el;
      }
    }
    return null;
  }

  /*
   * Find the action to click inside a tile, by text, in preference order.
   * Download is tried first because it pulls an already generated file.
   * When the tile offers no Download control, fall back to Prepare Offline,
   * which asks the portal to generate the file and usually navigates to the
   * offline screen. Returns null when neither tier matches.
   */
  function findTileAction(tile, returnType) {
    var tiers = [
      { name: "download", labels: (PORTAL_SELECTORS.text.tileButtonByReturn[returnType] ||
                                   PORTAL_SELECTORS.text.downloadActions) },
      { name: "prepareOffline", labels: PORTAL_SELECTORS.text.prepareOfflineActions }
    ];
    var actions = tile.querySelectorAll(PORTAL_SELECTORS.tileActions);

    for (var t = 0; t < tiers.length; t++) {
      var wanted = tiers[t].labels.map(normalize);
      for (var i = 0; i < actions.length; i++) {
        var node = actions[i];
        if (!isVisible(node)) {
          continue;
        }
        var label = normalize(node.textContent || node.value || node.getAttribute("aria-label"));
        for (var j = 0; j < wanted.length; j++) {
          if (label.indexOf(wanted[j]) !== -1) {
            return { node: node, tier: tiers[t].name, label: label };
          }
        }
      }
    }
    return null;
  }

  /* First visible button or link anywhere on the page whose text contains one
   * of the labels, tried in label order. */
  function findControlByLabels(labels) {
    var nodes = document.querySelectorAll("button, a");
    for (var l = 0; l < labels.length; l++) {
      var wanted = normalize(labels[l]);
      for (var i = 0; i < nodes.length; i++) {
        if (isVisible(nodes[i]) && normalize(nodes[i].textContent).indexOf(wanted) !== -1) {
          return { node: nodes[i], label: wanted };
        }
      }
    }
    return null;
  }

  async function waitForControl(labels, timeout) {
    var deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      var hit = findControlByLabels(labels);
      if (hit) {
        return hit;
      }
      await sleep(ABORT_TICK);
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Job state persistence                                               */
  /* ------------------------------------------------------------------ */

  function loadState() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (data) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve((data && data[STORAGE_KEY]) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function saveState(state) {
    return new Promise(function (resolve) {
      try {
        var payload = {};
        payload[STORAGE_KEY] = state;
        chrome.storage.local.set(payload, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function clearState() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.remove([STORAGE_KEY], function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function pendingMonths(state) {
    var done = state.completed || [];
    var failed = state.failed || [];
    return state.job.months.filter(function (m) {
      return done.indexOf(m) === -1 && failed.indexOf(m) === -1;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Dashboard automation                                                */
  /* ------------------------------------------------------------------ */

  function onDashboard() {
    return !!document.querySelector(PORTAL_SELECTORS.dashboardRoot) ||
           !!document.querySelector(PORTAL_SELECTORS.financialYearSelect);
  }

  async function ensureDashboard(delay) {
    if (onDashboard()) {
      return true;
    }
    log("Not on the Returns Dashboard, trying the back link.", "warn");
    var back = document.querySelector(PORTAL_SELECTORS.backToDashboard);
    if (back) {
      realClick(back);
      await sleep(delay);
      await waitForIdle();
    }
    var field = await waitForElementOptional(PORTAL_SELECTORS.financialYearSelect, { timeout: 15000 });
    return !!field;
  }

  async function selectPeriod(job, month) {
    var fySelect = await waitForElement(PORTAL_SELECTORS.financialYearSelect, {
      label: "financial year dropdown"
    });
    if (!setSelectValue(fySelect, job.financialYear)) {
      throw new Error("Financial year " + job.financialYear + " is not in the dropdown");
    }
    log("Financial year set to " + job.financialYear + ".", "step");
    await sleep(job.delay);

    if (job.filerType === "qrmp") {
      var quarterKey = QUARTER_OF_MONTH[month];
      var quarterLabel = PORTAL_SELECTORS.quarterLabels[quarterKey];
      var quarterSelect = await waitForElementOptional(PORTAL_SELECTORS.quarterSelect, {
        timeout: 8000,
        label: "quarter dropdown"
      });
      if (quarterSelect) {
        if (!setSelectValue(quarterSelect, quarterLabel)) {
          throw new Error("Quarter " + quarterLabel + " is not in the dropdown");
        }
        log("Quarter set to " + quarterLabel + ".", "step");
        await sleep(job.delay);
      } else {
        log("Quarter dropdown not present, continuing as a monthly filer.", "warn");
      }
    }

    var periodSelect = await waitForElement(PORTAL_SELECTORS.periodSelect, {
      label: "period dropdown"
    });
    if (!setSelectValue(periodSelect, month)) {
      throw new Error("Period " + month + " is not in the dropdown");
    }
    log("Period set to " + month + ".", "step");
    await sleep(job.delay);
  }

  async function runSearch(job) {
    var button = await waitForElement(PORTAL_SELECTORS.searchButton, {
      label: "search button"
    });
    realClick(button);
    log("Search clicked, waiting for the tile grid.", "step");
    /* Blind settle time only, the polling helpers do the real waiting. */
    await sleep(job.delay);
    await waitForIdle();
    /* Wait for the requested tile itself, by text, instead of a class name. */
    var deadline = Date.now() + WAIT_TIMEOUT;
    while (!findReturnTile(job.returnType)) {
      if (Date.now() > deadline) {
        throw TimeoutError("Timed out waiting for the " + job.returnType + " tile");
      }
      await sleep(ABORT_TICK);
    }
  }

  async function downloadForMonth(job, month) {
    await ensureDashboard(job.delay);
    await selectPeriod(job, month);
    await runSearch(job);

    var banner = document.querySelector(PORTAL_SELECTORS.errorBanner);
    if (banner && isVisible(banner)) {
      var bannerText = normalize(banner.textContent);
      var empty = PORTAL_SELECTORS.text.noRecords.some(function (phrase) {
        return bannerText.indexOf(normalize(phrase)) !== -1;
      });
      if (empty) {
        throw new Error("Portal reported no records for " + month);
      }
    }

    var tile = findReturnTile(job.returnType);
    if (!tile) {
      throw new Error("No " + job.returnType + " tile found for " + month);
    }
    var action = findTileAction(tile, job.returnType);
    if (!action) {
      throw new Error("No download or prepare offline action inside the " +
                      job.returnType + " tile for " + month);
    }
    if (action.tier === "prepareOffline") {
      log("No download control on the " + job.returnType + " tile, falling back to " +
          action.label.toLowerCase() + ".", "warn");
    }

    log("Clicking " + action.label.toLowerCase() + " on the " +
        job.returnType + " tile.", "step");
    /* VIEW and some DOWNLOAD buttons load a new page, which destroys this
     * script. Record the step first so the next page can finish the job. */
    if (runtime.state) {
      runtime.state.stage = "detail";
      await saveState(runtime.state);
    }
    realClick(action.node);
    await sleep(job.delay);
    await waitForIdle();

    /* The tile button opens a detail page with the real download button. */
    var direct = PORTAL_SELECTORS.text.directDownload.indexOf(job.returnType) !== -1;
    var detail = direct ? null : await waitForControl(PORTAL_SELECTORS.text.detailActions, 15000);
    if (detail) {
      log("Detail page open, clicking " + detail.label.toLowerCase() + ".", "step");
      realClick(detail.node);
      await sleep(job.delay);
      await waitForIdle();
    }

    /* Some flows land on the offline screen, which needs a second click and
     * navigates away from the dashboard. */
    var generate = (detail || direct) ? null : await waitForElementOptional(PORTAL_SELECTORS.offlineGenerateButton, {
      timeout: 8000
    });
    if (generate) {
      log("Offline screen detected, requesting file generation.", "step");
      realClick(generate);
      await sleep(job.delay);
      await waitForIdle();
      var link = await waitForElementOptional(PORTAL_SELECTORS.offlineDownloadLink, {
        timeout: 20000
      });
      if (link) {
        realClick(link);
        await sleep(job.delay);
      } else {
        log("Generation started but no download link appeared yet for " + month + ".", "warn");
      }
    }

    var pageText = normalize(document.body.textContent);
    var busyPhrase = PORTAL_SELECTORS.text.inProgress.filter(function (p) {
      return pageText.indexOf(p) !== -1;
    })[0];
    if (busyPhrase) {
      log(month + ": portal says the file is still generating (\"" + busyPhrase +
          "\"). Come back in about 20 minutes and run this period again.", "warn");
    }

    var back = findControlByLabels(PORTAL_SELECTORS.text.backActions);
    if (back && !onDashboard()) {
      realClick(back.node);
      await sleep(job.delay);
      await waitForIdle();
    }

    log(month + " handled.", "ok");
  }

  /* ------------------------------------------------------------------ */
  /* Job runner                                                          */
  /* ------------------------------------------------------------------ */

  async function runJob(state) {
    if (runtime.busy) {
      return;
    }
    runtime.busy = true;
    runtime.abort = false;

    runtime.state = state;
    var job = state.job;
    var total = job.months.length;

    push({ type: "JOB_EVENT", event: "started" });
    progress((state.completed || []).length, total);

    try {
      var queue = pendingMonths(state);
      if (!queue.length) {
        log("Nothing pending in the saved job.", "info");
      }

      for (var i = 0; i < queue.length; i++) {
        if (runtime.abort) {
          throw AbortError();
        }
        var month = queue[i];
        state.current = month;
        state.stage = null;
        state.status = "running";
        await saveState(state);

        log("Period " + month + " starting.", "info");
        var cooldown = Math.round(job.delay * FAILURE_COOLDOWN_MULTIPLIER);
        var attempt = 0;
        var lastError = null;

        /* Timeouts get one more attempt after a cooldown, since they usually
         * mean the portal was slow rather than that the period is unavailable.
         * Every other failure is final for this period. */
        while (true) {
          try {
            await downloadForMonth(job, month);
            lastError = null;
            break;
          } catch (err) {
            if (err && err.name === "AbortError") {
              throw err;
            }
            lastError = err;
            if (err.name !== "TimeoutError" || attempt >= TIMEOUT_RETRIES) {
              break;
            }
            attempt++;
            log(month + " timed out: " + err.message + ". Retry " + attempt +
                " of " + TIMEOUT_RETRIES + " after a cooldown.", "warn");
            await sleep(cooldown);
          }
        }

        if (lastError) {
          state.failed = (state.failed || []).concat([month]);
          log(month + " failed: " + lastError.message + ". Skipping to the next period.", "error");
          /* Longer cooldown so the portal is not hammered after a failure. */
          await sleep(cooldown);
        } else {
          state.completed = (state.completed || []).concat([month]);
        }

        state.current = null;
        await saveState(state);
        progress((state.completed || []).length + (state.failed || []).length, total);
        await sleep(job.delay);
      }

      state.status = "finished";
      await saveState(state);
      var okCount = (state.completed || []).length;
      var badCount = (state.failed || []).length;
      push({
        type: "JOB_EVENT",
        event: "finished",
        level: badCount ? "warn" : "ok",
        message: "Done. " + okCount + " succeeded, " + badCount + " failed."
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        state.status = "stopped";
        await saveState(state);
        push({
          type: "JOB_EVENT",
          event: "finished",
          level: "warn",
          message: "Stopped by user."
        });
      } else {
        state.status = "error";
        await saveState(state);
        push({
          type: "JOB_EVENT",
          event: "finished",
          level: "error",
          message: "Job aborted: " + err.message
        });
      }
    } finally {
      runtime.busy = false;
      runtime.abort = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Messaging                                                           */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) {
      return false;
    }

    if (msg.type === "PING") {
      sendResponse({ ok: true, busy: runtime.busy, href: location.href });
      return false;
    }

    if (msg.type === "START_JOB") {
      if (runtime.busy) {
        sendResponse({ ok: false, error: "A job is already running in this tab" });
        return false;
      }
      var job = msg.job || {};
      job.delay = Math.max(MIN_DELAY, parseInt(job.delay, 10) || DEFAULT_DELAY);
      var state = {
        job: job,
        completed: [],
        failed: [],
        current: null,
        status: "running",
        startedAt: Date.now()
      };
      saveState(state).then(function () {
        runJob(state);
      });
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "STOP_JOB") {
      runtime.abort = true;
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "STATUS") {
      sendResponse({ ok: true, busy: runtime.busy });
      return false;
    }

    return false;
  });

  /* ------------------------------------------------------------------ */
  /* Resume after navigation                                             */
  /* ------------------------------------------------------------------ */

  /*
   * Opening the offline download screen navigates away from the dashboard and
   * destroys this content script. When the next page loads, pick the job back
   * up from the first period that is neither completed nor failed.
   */
  /*
   * Runs on the page opened by a tile's VIEW button (for GSTR-1 the page with
   * DOWNLOAD FILED (PDF)). Clicks the download, records the result, then goes
   * back to the dashboard, where the next page load resumes the queue.
   */
  async function finishDetailPage(state) {
    var month = state.current;
    var delay = state.job.delay || DEFAULT_DELAY;
    await new Promise(function (resolve) { setTimeout(resolve, 2000); });
    await waitForIdle({ timeout: 15000 });

    var detail = await waitForControl(PORTAL_SELECTORS.text.detailActions, 30000);
    if (detail) {
      log("Detail page open, clicking " + detail.label.toLowerCase() + ".", "step");
      realClick(detail.node);
      await sleep(delay);
      await waitForIdle();
      state.completed = (state.completed || []).concat([month]);
      log(month + " handled.", "ok");
    } else {
      state.failed = (state.failed || []).concat([month]);
      log(month + ": no download button on the detail page. Download it by hand.", "error");
    }
    state.current = null;
    state.stage = null;
    await saveState(state);
    progress((state.completed || []).length + (state.failed || []).length, state.job.months.length);

    if (!pendingMonths(state).length) {
      state.status = "finished";
      await saveState(state);
      push({ type: "JOB_EVENT", event: "finished", level: "ok",
             message: "Done. " + state.completed.length + " succeeded, " +
                      (state.failed || []).length + " failed." });
    }

    /* Back to the dashboard. If that reloads the page, the next load resumes;
     * if it is an in-page route change, continue from here. */
    var back = findControlByLabels(PORTAL_SELECTORS.text.backActions);
    if (back) {
      realClick(back.node);
    }
    await new Promise(function (resolve) { setTimeout(resolve, 6000); });
    if (state.status !== "running") {
      return;
    }
    if (onDashboard()) {
      runJob(state);
    } else {
      location.href = "https://return.gst.gov.in/returns/auth/dashboard";
    }
  }

  async function resumeIfNeeded() {
    var state = await loadState();
    if (!state || state.status !== "running" || !state.job) {
      return;
    }
    var queue = pendingMonths(state);

    /* The period that was in flight when the page navigated has no result
     * recorded. Count it as failed so the job cannot loop on it forever. */
    if (state.current && state.stage === "detail") {
      await finishDetailPage(state);
      return;
    }

    if (state.current) {
      state.failed = (state.failed || []).concat([state.current]);
      log("Page navigated during " + state.current + ", marking it as needing a manual check.", "warn");
      state.current = null;
      await saveState(state);
      queue = pendingMonths(state);
    }

    if (!queue.length) {
      state.status = "finished";
      await saveState(state);
      return;
    }

    log("Resuming saved job, " + queue.length + " period(s) left.", "info");
    /* Let the new page settle before touching any control. */
    await new Promise(function (resolve) {
      setTimeout(resolve, 2000);
    });
    await waitForIdle({ timeout: 15000 });
    runJob(state);
  }

  resumeIfNeeded();

}());
