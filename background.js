"use strict";

/*
 * Sorts files downloaded during a job into
 *   Downloads/GST/<RETURN>/<RETURN>_<FY>_<Month or Quarter>.<ext>
 * e.g. GST/GSTR-1/GSTR-1_2025-26_April.pdf, or ..._Q1.pdf for QRMP filers.
 * using the job state that content.js keeps in chrome.storage.local.
 * Downloads outside a running job keep their normal name and folder.
 */

var STORAGE_KEY = "gstJobState";
var RETURN_LABELS = { GSTR1: "GSTR-1", GSTR2B: "GSTR-2B", GSTR3B: "GSTR-3B" };
var QUARTER_OF_MONTH = {
  April: "Q1", May: "Q1", June: "Q1", July: "Q2", August: "Q2", September: "Q2",
  October: "Q3", November: "Q3", December: "Q3", January: "Q4", February: "Q4", March: "Q4"
};

function fromGstPortal(item) {
  var urls = [item.url, item.finalUrl, item.referrer].join(" ");
  return urls.indexOf("gst.gov.in") !== -1;
}

function safe(part) {
  return String(part).replace(/[\\/:*?"<>|]+/g, "-").trim();
}

chrome.downloads.onDeterminingFilename.addListener(function (item, suggest) {
  if (!fromGstPortal(item)) {
    suggest();
    return false;
  }
  chrome.storage.local.get([STORAGE_KEY], function (data) {
    var state = data && data[STORAGE_KEY];
    if (!state || state.status !== "running" || !state.current || !state.job) {
      suggest();
      return;
    }
    var original = item.filename || "";
    var dot = original.lastIndexOf(".");
    var ext = dot > -1 ? original.slice(dot) : ".pdf";
    var parts = String(state.current).split(" ");
    var fy = safe(parts.length === 2 ? parts[0] : state.job.financialYear);
    var month = safe(parts.length === 2 ? parts[1] : state.current);
    var ret = RETURN_LABELS[state.job.returnType] || safe(state.job.returnType);
    /* QRMP filers download per quarter, so name the file by quarter. */
    var period = state.job.filerType === "qrmp" ? (QUARTER_OF_MONTH[month] || month) : month;
    suggest({
      filename: "GST/" + ret + "/" + ret + "_" + fy + "_" + period + ext,
      conflictAction: "uniquify"
    });
  });
  return true; /* suggest() is called asynchronously */
});
