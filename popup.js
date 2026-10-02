"use strict";

/*
 * Popup controller.
 * Responsibilities: build the form, validate the active tab, hand the job to
 * the content script (injecting it on demand when needed) and render progress.
 */

var FY_COUNT = 6;

/* Financial year order, April to March. The value is the label the portal
 * shows in its Period dropdown. */
var FY_MONTHS = [
  { value: "April", short: "Apr", calendarMonth: 4, offset: 0 },
  { value: "May", short: "May", calendarMonth: 5, offset: 0 },
  { value: "June", short: "Jun", calendarMonth: 6, offset: 0 },
  { value: "July", short: "Jul", calendarMonth: 7, offset: 0 },
  { value: "August", short: "Aug", calendarMonth: 8, offset: 0 },
  { value: "September", short: "Sep", calendarMonth: 9, offset: 0 },
  { value: "October", short: "Oct", calendarMonth: 10, offset: 0 },
  { value: "November", short: "Nov", calendarMonth: 11, offset: 0 },
  { value: "December", short: "Dec", calendarMonth: 12, offset: 0 },
  { value: "January", short: "Jan", calendarMonth: 1, offset: 1 },
  { value: "February", short: "Feb", calendarMonth: 2, offset: 1 },
  { value: "March", short: "Mar", calendarMonth: 3, offset: 1 }
];

var el = {};
var running = false;

function $(id) {
  return document.getElementById(id);
}

function currentFinancialYearStart() {
  var now = new Date();
  var year = now.getFullYear();
  /* getMonth() is zero based, so 3 is April. */
  return now.getMonth() >= 3 ? year : year - 1;
}

function financialYearLabel(startYear) {
  var end = String(startYear + 1).slice(-2);
  return startYear + "-" + end;
}

function buildFinancialYears() {
  var start = currentFinancialYearStart();
  var frag = document.createDocumentFragment();
  for (var i = 0; i < FY_COUNT; i++) {
    var y = start - i;
    var opt = document.createElement("option");
    opt.value = financialYearLabel(y);
    opt.textContent = financialYearLabel(y);
    frag.appendChild(opt);
  }
  el.fy.appendChild(frag);
  el.fy.options[0].selected = true;
}

function selectedYears() {
  var out = [];
  for (var i = 0; i < el.fy.options.length; i++) {
    if (el.fy.options[i].selected) {
      out.push(el.fy.options[i].value);
    }
  }
  return out.sort(); /* oldest year first */
}

function buildMonths() {
  var frag = document.createDocumentFragment();
  FY_MONTHS.forEach(function (m) {
    var label = document.createElement("label");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.value = m.value;
    box.className = "month-box";
    var span = document.createElement("span");
    span.textContent = m.short;
    label.appendChild(box);
    label.appendChild(span);
    frag.appendChild(label);
  });
  el.months.appendChild(frag);
}

function selectedMonths() {
  var out = [];
  var boxes = el.months.querySelectorAll("input.month-box");
  for (var i = 0; i < boxes.length; i++) {
    if (boxes[i].checked) {
      out.push(boxes[i].value);
    }
  }
  return out;
}

var QUARTER_END_MONTHS = ["June", "September", "December", "March"];

/* QRMP filers download once per quarter, on the quarter's last month, so
 * "select all" means the four quarter-end months only. */
function setAllMonths(state) {
  var qrmp = el.filerType && el.filerType.value === "qrmp";
  var boxes = el.months.querySelectorAll("input.month-box");
  for (var i = 0; i < boxes.length; i++) {
    boxes[i].checked = state && (!qrmp || QUARTER_END_MONTHS.indexOf(boxes[i].value) !== -1);
  }
}

function stamp() {
  var d = new Date();
  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function log(message, level) {
  var lv = level || "info";
  var line = document.createElement("div");
  var ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = "[" + stamp() + "] ";
  var body = document.createElement("span");
  body.className = "lv-" + lv;
  body.textContent = message;
  line.appendChild(ts);
  line.appendChild(body);
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function setRunning(state) {
  running = state;
  el.start.disabled = state;
  el.stop.disabled = !state;
  el.statusText.textContent = state ? "running" : "idle";
}

function setProgress(done, total) {
  if (!total) {
    el.progressText.textContent = "";
    return;
  }
  el.progressText.textContent = done + " of " + total + " periods";
}

function readDelay() {
  var raw = parseInt(el.delay.value, 10);
  if (isNaN(raw)) {
    raw = 4000;
  }
  if (raw < 3000) {
    raw = 3000;
  }
  if (raw > 15000) {
    raw = 15000;
  }
  el.delay.value = String(raw);
  return raw;
}

function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

function sendToTab(tabId, payload) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, payload, function (response) {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "empty response" });
    });
  });
}

function injectContentScript(tabId) {
  return new Promise(function (resolve) {
    chrome.scripting.executeScript(
      { target: { tabId: tabId }, files: ["content.js"] },
      function () {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

/* Probe the content script, injecting it if nothing answers the PING. */
async function ensureContentScript(tabId) {
  var probe = await sendToTab(tabId, { type: "PING" });
  if (probe && probe.ok) {
    return true;
  }
  log("No content script on the page, injecting it now.", "warn");
  var injected = await injectContentScript(tabId);
  if (!injected.ok) {
    log("Injection failed: " + injected.error, "error");
    return false;
  }
  await new Promise(function (r) {
    setTimeout(r, 300);
  });
  var second = await sendToTab(tabId, { type: "PING" });
  if (!second || !second.ok) {
    log("Content script still not responding: " + (second && second.error), "error");
    return false;
  }
  return true;
}

var DASHBOARD_URL = "https://return.gst.gov.in/returns/auth/dashboard";

/* Services > Returns > Returns Dashboard in one click. Reuses the GST tab
 * when it is the active one, otherwise opens a new tab. The portal sends
 * you to the login page first if the session has expired. */
async function goToDashboard() {
  var tab = await getActiveTab();
  if (tab && tab.id && /gst\.gov\.in/i.test(tab.url || "")) {
    chrome.tabs.update(tab.id, { url: DASHBOARD_URL });
  } else {
    chrome.tabs.create({ url: DASHBOARD_URL });
  }
  log("Opening the Returns Dashboard. Log in first if the portal asks.", "info");
}

async function onStart() {
  var years = selectedYears();
  var picked = selectedMonths();
  if (!years.length || !picked.length) {
    log("Select at least one financial year and one period first.", "error");
    return;
  }
  /* One queue across all years: "2024-25 June", "2024-25 September", ... */
  var months = [];
  years.forEach(function (fy) {
    picked.forEach(function (m) { months.push(fy + " " + m); });
  });
  var tab = await getActiveTab();
  if (!tab || !tab.id) {
    log("Could not read the active tab.", "error");
    return;
  }
  if (!/^https:\/\/([a-z0-9-]+\.)*gst\.gov\.in\//i.test(tab.url || "")) {
    log("Active tab is not on gst.gov.in. Open the Returns Dashboard first.", "error");
    return;
  }

  var ready = await ensureContentScript(tab.id);
  if (!ready) {
    return;
  }

  var job = {
    financialYear: years[0],
    financialYears: years,
    returnType: el.returnType.value,
    filerType: el.filerType.value,
    months: months,
    delay: readDelay()
  };

  setRunning(true);
  setProgress(0, months.length);
  log("Starting " + job.returnType + " for FY " + years.join(", ") +
      " over " + months.length + " period(s).", "ok");

  var reply = await sendToTab(tab.id, { type: "START_JOB", job: job });
  if (!reply || !reply.ok) {
    setRunning(false);
    log("Could not start: " + (reply && reply.error), "error");
  }
}

async function onStop() {
  var tab = await getActiveTab();
  if (!tab || !tab.id) {
    return;
  }
  log("Stop requested.", "warn");
  await sendToTab(tab.id, { type: "STOP_JOB" });
  setRunning(false);
}

/* Progress arrives from the content script while the popup is open. */
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== "JOB_EVENT") {
    return;
  }
  if (msg.event === "log") {
    log(msg.message, msg.level || "info");
  } else if (msg.event === "progress") {
    setProgress(msg.done, msg.total);
  } else if (msg.event === "started") {
    setRunning(true);
  } else if (msg.event === "finished") {
    setRunning(false);
    log(msg.message || "Job finished.", msg.level || "ok");
  }
});

/* If a job survived a popup close or a page navigation, show its state. */
async function restoreState() {
  chrome.storage.local.get(["gstJobState"], function (data) {
    var state = data && data.gstJobState;
    if (!state) {
      return;
    }
    if (state.job) {
      var years = state.job.financialYears || [state.job.financialYear];
      for (var y = 0; y < el.fy.options.length; y++) {
        el.fy.options[y].selected = years.indexOf(el.fy.options[y].value) !== -1;
      }
      el.returnType.value = state.job.returnType;
      el.filerType.value = state.job.filerType || "monthly";
      el.delay.value = String(state.job.delay || 4000);
      var boxes = el.months.querySelectorAll("input.month-box");
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].checked = state.job.months.some(function (key) {
          return key === boxes[i].value || key.split(" ")[1] === boxes[i].value;
        });
      }
    }
    var done = state.completed ? state.completed.length : 0;
    var total = state.job && state.job.months ? state.job.months.length : 0;
    setProgress(done, total);
    if (state.status === "running") {
      setRunning(true);
      log("Resumed view of a job already in progress.", "info");
    } else if (state.status) {
      log("Last job status: " + state.status + ".", "info");
    }
  });
}

document.addEventListener("DOMContentLoaded", function () {
  el.fy = $("fy");
  el.returnType = $("returnType");
  el.filerType = $("filerType");
  el.months = $("months");
  el.delay = $("delay");
  $("goDashboard").addEventListener("click", goToDashboard);
  el.start = $("start");
  el.stop = $("stop");
  el.log = $("log");
  el.statusText = $("statusText");
  el.progressText = $("progressText");

  buildFinancialYears();
  buildMonths();

  $("selectAll").addEventListener("click", function () {
    setAllMonths(true);
  });
  $("clearAll").addEventListener("click", function () {
    setAllMonths(false);
  });
  el.filerType.addEventListener("change", function () {
    if (el.filerType.value === "qrmp") {
      setAllMonths(true);
      log("QRMP: selected the last month of every quarter (Jun, Sep, Dec, Mar).", "info");
    }
  });
  el.delay.addEventListener("change", readDelay);
  el.start.addEventListener("click", onStart);
  el.stop.addEventListener("click", onStop);

  log("Ready. Open the Returns Dashboard before starting.", "info");
  restoreState();
});
