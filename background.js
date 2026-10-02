"use strict";

/*
 * Sorts files downloaded during a job into
 *   Downloads/GST/<FY>/<Month>/<RETURN>_<FY>_<Month>.<ext>
 * using the job state that content.js keeps in chrome.storage.local.
 * Downloads outside a running job keep their normal name and folder.
 */

var STORAGE_KEY = "gstJobState";
var RETURN_LABELS = { GSTR1: "GSTR-1", GSTR2B: "GSTR-2B", GSTR3B: "GSTR-3B" };

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
    suggest({
      filename: "GST/" + fy + "/" + month + "/" + ret + "_" + fy + "_" + month + ext,
      conflictAction: "uniquify"
    });
  });
  return true; /* suggest() is called asynchronously */
});
