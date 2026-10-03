# MiyeeIndia GST Return Downloader

by Vipin Nair · Free and open source

**Why this tool exists:** downloading GST returns month by month is slow and
tiresome, especially collecting every GSTR-2B for the annual ITC
reconciliation. This tool automates those clicks for GSTR-1, GSTR-2B and
GSTR-3B.

**Privacy (designed in line with the Digital Personal Data Protection Act,
2023):** the tool runs entirely inside your own browser. You log in to
gst.gov.in yourself; your user ID, password and OTP are never seen, stored or
shared by the tool. No personal data is collected, and nothing is sent to any
server other than the GST portal you are already using.

**Disclaimer:** created on 02.10.2026. The GST portal may change its layout at
any time, which can stop the tool from working properly until it is updated.

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
5. "Pause between periods" defaults to 2000ms (minimum 1000ms). Steps inside a
   period no longer use fixed delays: each waits for the portal's own signal
   (options loaded, loading overlay gone, download started).
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
   Every label you want the extension to click must appear in either
   `PORTAL_SELECTORS.text.downloadActions` or
   `PORTAL_SELECTORS.text.prepareOfflineActions`. The two lists are tried in
   that order: a direct Download is preferred, and Prepare Offline is used only
   when the tile offers no Download control.
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

Tile actions are also two tiered. A tile that already has a generated file
shows Download; one that does not shows Prepare Offline. `findTileAction` tries
`downloadActions` across every visible control in the tile first and only then
tries `prepareOfflineActions`, logging a warning when it falls back. Prepare
Offline normally lands on the offline screen, which the engine then drives with
`offlineGenerateButton` and `offlineDownloadLink`.

Waiting is done by polling (`waitForElement`, `waitForIdle`) wherever a specific
element or a quiet DOM is the real signal. Blind sleeps are used only as settle
time immediately after a click.

## Troubleshooting

**"The GST tab needs a refresh"**
Normal right after installing or reloading the extension: tabs opened before
that do not have the content script yet. Press F5 on the GST tab once.

**"Timed out waiting for ..."**
The named selector no longer matches, or the portal was simply slow. A period
that fails on a timeout is retried once after a longer cooldown before it is
marked failed, so a single warning line followed by a success is normal. If the
retry times out too, run the checklist entry for the named selector.

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

## Selenium app (`gst_downloader.py`)

A no-extension alternative that drives your local Chrome and also fetches
**GSTR-2B**.

```
pip install -r requirements.txt
python gst_downloader.py                       # uses TARGETS at the top of the file
python gst_downloader.py --fy 2024-25 --months April May --returns GSTR-2B
```

- Edit `DOWNLOAD_DIR`, `RETURNS`, `TARGETS` (list of FY/month dicts) and
  `QRMP_FILER` at the top of the file.
- Chrome opens the login page and the script pauses; log in (CAPTCHA/OTP),
  open the Returns Dashboard, press Enter in the terminal.
- Files are saved to `DOWNLOAD_DIR/<FY>/<Month>/<RETURN>_<FY>_<Month>.<ext>`;
  `results.csv` and `gst_downloader.log` summarise each period.
- Unfiled periods are logged as SKIPPED and the run continues. If the portal
  says a file is still generating, the period is queued, the session is kept
  alive, and it is retried after `PENDING_RETRY_AFTER_MINUTES`.
- Chromedriver is handled by `webdriver-manager`, or pass `--chromedriver`.

**Not yet verified against the live portal.** All locators (`DROPDOWNS`,
`RETURN_SPECS`, phrase lists) are relative XPaths on visible text and are best
guesses; confirm each once in DevTools and adjust them in that one section.
The extension also gained a GSTR-2B option and an "in progress" warning.

## Chrome Web Store

- Permissions are limited to `storage`, `downloads` and `https://*.gst.gov.in/*`.
  No `scripting`, `tabs` or `activeTab`, and no network requests of any kind.
- `./package.sh` builds the upload ZIP with only the extension files (the
  Python script, guide and README are left out).
- Privacy policy: [`PRIVACY.md`](PRIVACY.md). With GitHub Pages enabled
  (Settings > Pages > Deploy from branch `main`, folder `/`), it is served at
  `https://vipinnairv.github.io/miyeegstdownload/PRIVACY`.
- Architecture: the job loop runs in `content.js` inside the GST tab and keeps
  its progress in `chrome.storage.local`, so it survives page reloads. The
  service worker (`background.js`) holds no in-memory state; it only names
  downloads and records when one starts, reading everything from storage.
