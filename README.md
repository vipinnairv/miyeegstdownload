# GST Returns Bulk Downloader

A Chrome and Edge Manifest V3 extension that automates the repetitive part of
pulling GSTR-1 and GSTR-3B returns from the Indian GST portal
(https://www.gst.gov.in). You pick a financial year, a return type and a set of
periods, and the extension drives the Returns Dashboard for each period in turn:
set the dropdowns, click Search, wait for the tile grid, then click Download or
Prepare Offline on the correct tile.

Vanilla JavaScript, HTML and CSS only. No frameworks, no build step, no npm
dependencies.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 declaration, permissions and content script registration |
| `popup.html` | Dark themed control panel |
| `popup.js` | Form building, tab validation, message dispatch, live log pane |
| `content.js` | The DOM engine that runs on the portal page |
| `README.md` | This file |
| `LICENSE` | MIT |

## Install the unpacked extension

1. Clone or download this repository to a folder you will keep. Chrome loads
   unpacked extensions from disk every time it starts, so do not put it in a
   temporary directory.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** with the toggle in the top right corner.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. The extension appears in the list. Pin it from the puzzle piece icon in the
   toolbar so the popup is one click away.
6. After you edit any file, click the reload arrow on the extension card, then
   reload the GST portal tab. Content script changes do not apply to pages that
   were already open.

## Use it

1. Log in to the GST portal and navigate to **Returns** then
   **Returns Dashboard**. The extension refuses to start on any other host.
2. Click the extension icon.
3. Choose the financial year, the return type, and tick the periods you want.
4. Choose **Monthly** or **QRMP** as the filer type. QRMP adds the quarter
   dropdown step.
5. Set the step delay. The default is 4000ms and the minimum accepted is
   3000ms. Raise it if the portal is slow or if you see timeouts.
6. Click **Start** and leave the tab in the foreground. Watch the log pane.
7. **Stop** aborts within about a quarter of a second, because the abort flag is
   checked inside the sleep helper rather than only between periods.

If the popup is closed while a job runs, the job keeps going. Reopen the popup
to see the current progress counter. Job state lives in `chrome.storage.local`
under the key `gstJobState`, so if the portal navigates away from the dashboard
and destroys the content script, the next page load resumes from the first
period that has neither succeeded nor failed.

## Updating the selectors

The GST portal changes its markup without notice, and every selector shipped
here is a **placeholder**. All of them live in one object, `PORTAL_SELECTORS`,
at the top of `content.js`. Nothing else in the file contains a portal selector
string, so a portal redesign is a single edit in a single place.

The object also holds the text matchers (`PORTAL_SELECTORS.text`) and the
quarter labels, because tiles are matched by their visible text rather than by
position. The portal reuses generic class names across tiles, so an index based
match silently downloads the wrong return.

### Console checklist, one selector at a time

Do this once before your first real run, and again whenever a run starts
failing. Open the Returns Dashboard, press F12, and paste each snippet into the
Console. Fix the matching entry in `PORTAL_SELECTORS` before moving to the next
line. A helper to keep at the top of the console session:

```js
const q = (s) => { const n = document.querySelectorAll(s); console.log(n.length, n[0]); return n[0]; };
```

On the **Returns Dashboard**, before clicking Search:

1. `q("select[name='fin'], select[ng-model='fin'], #fin")`
   Financial year dropdown. Expect exactly one node. Then confirm the option
   labels match what the popup sends, for example `2025-26`:
   `[...q("#fin").options].map(o => o.textContent.trim())`
2. `q("select[name='quarter'], select[ng-model='quarter'], #quarter")`
   Quarter dropdown. QRMP filers only. If you are a monthly filer this should
   find nothing, which is fine. If it exists, check whether its labels read
   `Quarter 1` or `Apr-Jun` and update `PORTAL_SELECTORS.quarterLabels`.
3. `q("select[name='mon'], select[ng-model='mon'], #mon")`
   Period dropdown. Confirm the labels are full month names such as `April`.
4. `q("button.srch, button[data-ng-click*='search'], button[type='submit']")`
   Search button. Make sure the first match is Search and not some other submit
   button on the page.
5. `q("div.loading, div.loader, div.modal-backdrop, .cdk-overlay-backdrop")`
   Loading overlay. Trigger a Search manually and re-run this while the spinner
   is on screen. If it never matches, `waitForIdle` falls back to waiting for
   the DOM to go quiet, which still works but is slower.

Now click **Search** manually and wait for the tiles:

6. `q("div.dashboardTiles, div.tabpane, div[class*='card-group']")`
   Tile grid wrapper.
7. `document.querySelectorAll("div.card, div.panel, div.tile").length`
   Individual tiles. Expect the number of tiles you can actually see.
8. Confirm the title element and read every tile title:
   ```js
   [...document.querySelectorAll("div.card, div.panel, div.tile")]
     .map(t => (t.querySelector("div.card-header, h4, h5, .panel-heading") || t).textContent.trim().slice(0, 60));
   ```
   This is the important one. Check that the GSTR-1 tile and any GSTR-1A or IFF
   tile are distinguishable by text, and that
   `PORTAL_SELECTORS.text.gstr1ExcludeAliases` covers the ones you must not hit.
9. Inside the tile you care about, list the action labels:
   ```js
   [...document.querySelectorAll("div.card, div.panel, div.tile")]
     .flatMap(t => [...t.querySelectorAll("button, a.btn, a[href]")])
     .map(b => b.textContent.trim()).filter(Boolean);
   ```
   Every label you want the extension to click must appear in
   `PORTAL_SELECTORS.text.downloadActions`.
10. `q("div.alert-danger, div.err, span.err")`
    Error banner. Search a period you never filed to see the real wording, then
    put that wording in `PORTAL_SELECTORS.text.noRecords`.

Finally, click Download or Prepare Offline manually once:

11. `q("button[data-ng-click*='generate'], button.generateFile")`
    Generate button on the offline screen.
12. `q("a[data-ng-click*='download'], a.downloadLink, a[href*='download']")`
    Download link that appears after generation completes.
13. `q("a[href*='returns/dashboard'], button.backBtn")`
    Back to dashboard control, used to return before the next period.

When all thirteen resolve to the node you expect, run a **single period** job
first. Only queue a full year once one period completes end to end.

## How it drives an AngularJS page

The portal is an AngularJS application, which means two things:

- Setting `select.value` does not update `ng-model`. `setSelectValue` assigns
  the value and then dispatches `input`, `change` and `blur`, all with
  `bubbles: true`.
- `element.click()` skips `mousedown` and `mouseup`, which some controls listen
  for. `realClick` dispatches `mouseover`, `mousedown`, `mouseup` and `click` as
  real `MouseEvent` objects with coordinates.

Waiting is done by polling (`waitForElement`, `waitForIdle`) wherever a specific
element or a quiet DOM is the real signal. Blind sleeps are used only as settle
time immediately after a click.

## Troubleshooting

**"No content script on the page, injecting it now."**
Normal after reloading the extension. The popup pings the page and falls back to
`chrome.scripting.executeScript`. `content.js` guards against double injection
with `window.__gstBulkDownloaderLoaded`.

**"Timed out waiting for ..."**
The named selector no longer matches. Run the checklist entry for it.

**A period is marked as needing a manual check.**
The page navigated while that period was in flight. The resume logic records it
as failed rather than risking an endless loop, so download that one by hand.

**Everything times out at the first dropdown.**
You are probably not on the Returns Dashboard, or your session expired. Log in
again and reload.

## Disclaimer

This is an unofficial, community written tool. It is not affiliated with,
endorsed by, or supported by the Goods and Services Tax Network, the GST
Council, or any Indian government body.

It automates clicks in your own logged in browser session. It does not store,
transmit or read your credentials, and it sends nothing to any third party
server. You remain responsible for how you use it, including compliance with the
GST portal terms of use. Automated interaction may be rate limited or blocked by
the portal at any time.

Always verify every downloaded return against the portal before relying on it
for filing, reconciliation or audit. The authors accept no liability for missing
files, wrong periods, or any consequence of using this software. See `LICENSE`.
