# Privacy Policy: MiyeeIndia GST Return Downloader

**Effective date:** 3 October 2026
**Developer:** Vipin Nair (MiyeeIndia)
**Extension:** MiyeeIndia GST Return Downloader (Chrome / Edge browser extension)

## Summary

MiyeeIndia GST Return Downloader is a free, open-source tool that runs **entirely
inside your own browser**. It does **not** collect, store, sell or transmit any
personal data, and it does **not** have access to your GST portal credentials.
There is no analytics, no tracking and no server operated by the developer.

## 1. What the extension does

On the GST portal (`https://*.gst.gov.in`) the extension clicks the portal's own
buttons for you: it selects the financial year, quarter and period you chose,
opens the GSTR-1, GSTR-2B or GSTR-3B tile, and clicks the portal's download
button. The files you download come directly from the GST portal to your
computer, exactly as if you had clicked the buttons yourself.

## 2. Data we do not collect

The extension does **not** collect, record or transmit:

- your GST portal user ID, password, OTP or CAPTCHA (you type these yourself on
  gst.gov.in; the extension never reads those fields);
- your GSTIN, name, address, or any business or tax data shown on the portal;
- the contents of any return or downloaded file;
- browsing history, location, device identifiers, or usage statistics.

## 3. Data stored only on your device

To keep a multi-period job running across page reloads, the extension saves a
small amount of **job state** in your browser's local extension storage
(`chrome.storage.local`):

- the financial year(s), return type, filer type and periods you selected;
- which periods are completed or failed, and the current step;
- the time the last portal download started (used only to know when a file has
  begun downloading).

This information never leaves your computer, is not linked to your identity,
and is overwritten by your next job. You can delete it at any time by removing
the extension or clearing its data in Chrome.

Downloaded returns are saved by Chrome in your own Downloads folder
(`Downloads/GST/<Return type>/`). The extension only chooses the file name.

## 4. No network requests and no third parties

The extension makes **no network requests of its own**. It contains no
analytics, advertising, tracking, remote code or external scripts, and it shares
no data with the developer or any third party. The only website it interacts
with is the GST portal you are already logged in to.

## 5. Permissions and why they are needed

| Permission | Why |
| --- | --- |
| Access to `https://*.gst.gov.in/*` | To click the portal's buttons on the GST Returns Dashboard. The extension runs on no other website. |
| `storage` | To remember the job progress locally (section 3) so a job survives page reloads. |
| `downloads` | To give each downloaded return a clear file name and folder (for example `GST/GSTR-1/GSTR-1_2025-26_April.pdf`). |

## 6. Digital Personal Data Protection Act, 2023 (India)

The extension is designed in line with the principles of the Digital Personal
Data Protection Act, 2023: it processes no personal data on behalf of the
developer, keeps everything on your device, and collects nothing by default.
Because no personal data reaches the developer, there is no data held by the
developer to access, correct or erase.

## 7. Children

The extension is a professional tax tool and is not directed at children.

## 8. Open source

The full source code is public at
<https://github.com/vipinnairv/miyeegstdownload>, so anyone can verify the
statements in this policy.

## 9. Changes to this policy

If this policy changes, the updated version will be published at the same
address with a new effective date.

## 10. Contact

Questions about this policy can be raised as an issue at
<https://github.com/vipinnairv/miyeegstdownload/issues>.

---

*This is an unofficial tool. It is not made, endorsed or supported by GSTN or
the Government of India.*
