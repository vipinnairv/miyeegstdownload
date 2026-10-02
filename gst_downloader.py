#!/usr/bin/env python3
"""
GST Returns Bulk Downloader (Selenium edition).

Downloads GSTR-1, GSTR-2B and GSTR-3B from the Indian GST portal for a list
of financial years and months, using your own local Chrome. No paid
extensions, and nothing is sent anywhere except to gst.gov.in.

Flow
----
1. Chrome opens the GST login page and the script PAUSES.
2. You log in by hand (username, password, CAPTCHA, OTP) and open the
   Returns Dashboard, then press Enter in the terminal.
3. For every (financial year, month, return) the script selects the period,
   clicks SEARCH, finds the return's card by its visible text and downloads.
4. Files land in DOWNLOAD_DIR/<FY>/<Month>/ and are renamed
   <RETURN>_<FY>_<Month>.<ext>. A results.csv and a log file are written.

Every portal locator is a relative XPath on visible text and lives in the
LOCATORS / RETURN_SPECS section below. The portal changes its markup without
notice: if a step starts failing, fix that one entry there, nothing else.
The XPaths shipped here are best-effort and must be verified once on the live
portal (see README, "Selenium app").

Usage
-----
    pip install -r requirements.txt
    python gst_downloader.py
    python gst_downloader.py --fy 2024-25 --months April May --returns GSTR-2B
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional

from selenium import webdriver
from selenium.common.exceptions import (
    ElementClickInterceptedException,
    NoSuchElementException,
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait

# ===========================================================================
# 1. USER CONFIGURATION: edit this block to change the download scope
# ===========================================================================

# Absolute path. Created if missing. Files are sorted into FY/Month subfolders.
DOWNLOAD_DIR = Path.home() / "GST_Downloads"

# Which returns to fetch. Any of "GSTR-1", "GSTR-2B", "GSTR-3B".
RETURNS = ["GSTR-1", "GSTR-2B", "GSTR-3B"]

# Scope of the run. Add or remove dictionaries freely. "months" are the full
# month names exactly as the portal's Period dropdown shows them.
TARGETS = [
    {
        "financial_year": "2024-25",
        "months": ["April", "May", "June"],
    },
    {
        "financial_year": "2025-26",
        "months": ["April", "May", "June", "July", "August", "September"],
    },
]

# QRMP filers: the portal shows a Quarter dropdown before Period. Set True
# and the quarter is derived from the month automatically.
QRMP_FILER = False

# Optional "extra" file formats. GSTR-2B and GSTR-1 can offer several; list
# the ones you want, in order. Matched against the visible button text.
#   "GSTR-2B": any of "EXCEL", "JSON", "PDF"
#   "GSTR-1" : any of "PDF", "JSON"
#   "GSTR-3B": "PDF"
FORMATS = {
    "GSTR-1": ["PDF", "JSON"],
    "GSTR-2B": ["EXCEL", "JSON", "PDF"],
    "GSTR-3B": ["PDF"],
}

# Timing (seconds)
PAGE_TIMEOUT = 40            # waiting for a dropdown / card / button
DOWNLOAD_TIMEOUT = 120       # waiting for a file to finish downloading
GENERATE_TIMEOUT = 45        # waiting for "Generate" to produce a link
POST_CLICK_PAUSE = 1.0       # small settle time after a click

# Large GSTR-2B (and some GSTR-1) files are generated asynchronously: the
# portal says "come back after 20 minutes". Those periods are queued, and
# after the main pass the script waits (keeping the session alive) and
# retries them. Set to 0 to skip the second pass and only log them.
PENDING_RETRY_AFTER_MINUTES = 20
PENDING_MAX_ROUNDS = 2
SESSION_KEEPALIVE_EVERY = 4 * 60   # portal logs you out after ~15 idle min

LOGIN_URL = "https://services.gst.gov.in/services/login"
DASHBOARD_URL = "https://return.gst.gov.in/returns/auth/dashboard"

# ===========================================================================
# 2. LOCATORS: relative XPaths on visible text. Verify once on the live portal
# ===========================================================================

MONTH_ORDER = [
    "April", "May", "June", "July", "August", "September",
    "October", "November", "December", "January", "February", "March",
]
QUARTER_OF_MONTH = {
    **dict.fromkeys(["April", "May", "June"], "Quarter 1"),
    **dict.fromkeys(["July", "August", "September"], "Quarter 2"),
    **dict.fromkeys(["October", "November", "December"], "Quarter 3"),
    **dict.fromkeys(["January", "February", "March"], "Quarter 4"),
}


def _ci(text_expr: str, needle: str) -> str:
    """XPath: case-insensitive 'contains' of `needle` in `text_expr`."""
    needle = needle.lower()
    return (
        "contains(translate(normalize-space({e}), "
        "'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{n}')"
    ).format(e=text_expr, n=needle)


# Each dropdown: tried in order, first hit wins. Label-relative XPaths survive
# id/name changes; name/ng-model attributes are the fallback.
DROPDOWNS = {
    "fy": [
        "//label[contains(normalize-space(.), 'Financial Year')]/following::select[1]",
        "//select[@name='fin' or @id='fin' or contains(@data-ng-model, 'fin')]",
    ],
    "quarter": [
        "//label[contains(normalize-space(.), 'Quarter')]/following::select[1]",
        "//select[@name='quarter' or @id='quarter']",
    ],
    "period": [
        "//label[contains(normalize-space(.), 'Period')]/following::select[1]",
        "//select[@name='mon' or @id='mon' or contains(@data-ng-model, 'mon')]",
    ],
}

SEARCH_BUTTON = (
    "//button[normalize-space(.)='SEARCH' or normalize-space(.)='Search'"
    " or contains(normalize-space(.), 'SEARCH')]"
)

# Loading spinners / modal backdrops that block clicks while Angular redraws.
BUSY_OVERLAYS = (
    "//*[(contains(@class,'loading') or contains(@class,'loader')"
    " or contains(@class,'modal-backdrop') or contains(@class,'spinner'))"
    " and not(contains(@style,'display: none'))]"
)

# Page text that means "nothing to download for this period".
NOT_FILED_PHRASES = [
    "no record", "not filed", "no data", "not available", "no return",
    "no records found", "not yet filed", "nil return",
]
# Page text that means "the portal is still building the file".
IN_PROGRESS_PHRASES = [
    "in progress", "being generated", "is being processed",
    "come back after", "request is being", "after 20 minutes", "try after",
    "generation is in progress", "will be available",
]
# Page text that means the session died.
SESSION_EXPIRED_MARKERS = ["login", "session expired", "session has expired"]


@dataclass
class ReturnSpec:
    """How to find and download one return."""

    name: str
    # Leaf-element text aliases that identify the card heading.
    title_aliases: list[str]
    # Aliases that must NOT appear in the card (e.g. GSTR-1A inside GSTR-1).
    exclude_aliases: list[str] = field(default_factory=list)
    # Button on the dashboard card that opens the download area. Tried in
    # order; the first visible one wins.
    card_buttons: list[str] = field(default_factory=lambda: ["DOWNLOAD"])
    # Format keyword -> ordered list of button texts to click to obtain it.
    # A "generate" style button is followed by a "download" one automatically.
    format_buttons: dict[str, list[str]] = field(default_factory=dict)


RETURN_SPECS: dict[str, ReturnSpec] = {
    "GSTR-1": ReturnSpec(
        name="GSTR-1",
        title_aliases=["GSTR1", "GSTR-1"],
        exclude_aliases=["GSTR1A", "GSTR-1A", "IFF"],
        card_buttons=["DOWNLOAD", "PREPARE OFFLINE"],
        format_buttons={
            "PDF": ["DOWNLOAD (PDF)", "GENERATE PDF", "SUMMARY"],
            "JSON": ["GENERATE JSON FILE TO DOWNLOAD", "GENERATE FILE", "DOWNLOAD (JSON)"],
        },
    ),
    "GSTR-2B": ReturnSpec(
        name="GSTR-2B",
        title_aliases=["GSTR2B", "GSTR-2B"],
        card_buttons=["DOWNLOAD"],
        format_buttons={
            "EXCEL": ["GENERATE EXCEL FILE TO DOWNLOAD", "DOWNLOAD GSTR-2B (EXCEL)", "EXCEL"],
            "JSON": ["GENERATE JSON FILE TO DOWNLOAD", "DOWNLOAD GSTR-2B (JSON)", "JSON"],
            "PDF": ["DOWNLOAD GSTR-2B SUMMARY (PDF)", "DOWNLOAD SUMMARY", "PDF"],
        },
    ),
    "GSTR-3B": ReturnSpec(
        name="GSTR-3B",
        title_aliases=["GSTR3B", "GSTR-3B"],
        card_buttons=["DOWNLOAD"],
        format_buttons={
            "PDF": ["DOWNLOAD", "DOWNLOAD (PDF)", "PDF"],
        },
    ),
}

# After a "generate" click, these buttons/links produce the real file.
FINAL_DOWNLOAD_TEXTS = ["DOWNLOAD FILE", "DOWNLOAD", "CLICK HERE TO DOWNLOAD", "DOWNLOAD FILE 1"]
# Buttons that return to the dashboard from a sub-page.
BACK_TEXTS = ["BACK", "BACK TO DASHBOARD"]

DOWNLOAD_SUFFIXES = (".pdf", ".json", ".xlsx", ".xls", ".zip", ".csv")
PARTIAL_SUFFIXES = (".crdownload", ".tmp", ".part")

# ===========================================================================
# 3. Exceptions and result types
# ===========================================================================


class ReturnNotAvailable(Exception):
    """The return is not filed / has no data for this period. Skip it."""


class GenerationInProgress(Exception):
    """The portal is still building the file. Retry later."""


class SessionExpired(Exception):
    """Portal logged us out."""


@dataclass
class Task:
    fy: str
    month: str
    ret: str
    fmt: Optional[str] = None  # filled when queued for retry

    def label(self) -> str:
        return f"{self.ret} {self.fy} {self.month}"


@dataclass
class Result:
    task: Task
    status: str          # DOWNLOADED | SKIPPED | PENDING | FAILED
    detail: str = ""
    files: list[str] = field(default_factory=list)


log = logging.getLogger("gst")

# ===========================================================================
# 4. Driver setup
# ===========================================================================


def setup_driver(download_dir: Path, chromedriver: Optional[str] = None) -> WebDriver:
    """Chrome that downloads PDFs/JSON/Excel silently into `download_dir`."""
    download_dir.mkdir(parents=True, exist_ok=True)
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option(
        "prefs",
        {
            "download.default_directory": str(download_dir.resolve()),
            "download.prompt_for_download": False,
            "download.directory_upgrade": True,
            "safebrowsing.enabled": True,
            # Download PDFs instead of opening Chrome's viewer.
            "plugins.always_open_pdf_externally": True,
            "profile.default_content_setting_values.automatic_downloads": 1,
        },
    )
    binary = os.environ.get("CHROME_BINARY")
    if binary:
        options.binary_location = binary
    if os.environ.get("GST_HEADLESS") == "1":  # only useful for self-tests
        options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")

    driver_path = chromedriver or os.environ.get("CHROMEDRIVER")
    if not driver_path:
        # Imported lazily so --chromedriver works without the package/network.
        from webdriver_manager.chrome import ChromeDriverManager

        driver_path = ChromeDriverManager().install()
    driver = webdriver.Chrome(service=Service(driver_path), options=options)
    driver.implicitly_wait(0)  # explicit waits only; mixing them hides bugs
    return driver


# ===========================================================================
# 5. Resilient interaction helpers (Angular redraws, stale elements)
# ===========================================================================


def wait(driver: WebDriver, timeout: float = PAGE_TIMEOUT) -> WebDriverWait:
    return WebDriverWait(
        driver,
        timeout,
        poll_frequency=0.4,
        ignored_exceptions=(StaleElementReferenceException, NoSuchElementException),
    )


def wait_not_busy(driver: WebDriver, timeout: float = PAGE_TIMEOUT) -> None:
    """Wait until no loading overlay is visible. Never raises on timeout."""
    def idle(d: WebDriver) -> bool:
        return not any(e.is_displayed() for e in d.find_elements(By.XPATH, BUSY_OVERLAYS))

    try:
        wait(driver, timeout).until(idle)
    except TimeoutException:
        log.debug("Overlay still visible after %ss, continuing", timeout)


def retry_on_stale(fn: Callable, attempts: int = 5, pause: float = 0.5):
    """Re-run `fn` (which must re-find its elements) when Angular redraws."""
    last: Exception | None = None
    for _ in range(attempts):
        try:
            return fn()
        except (StaleElementReferenceException, ElementClickInterceptedException) as exc:
            last = exc
            time.sleep(pause)
    assert last is not None
    raise last


def find_visible(driver: WebDriver, xpaths: Iterable[str], timeout: float = PAGE_TIMEOUT) -> WebElement:
    """First displayed element matching any XPath, polling until timeout."""
    xpaths = list(xpaths)

    def probe(d: WebDriver):
        for xp in xpaths:
            for el in d.find_elements(By.XPATH, xp):
                try:
                    if el.is_displayed():
                        return el
                except StaleElementReferenceException:
                    continue
        return False

    try:
        return wait(driver, timeout).until(probe)
    except TimeoutException:
        raise TimeoutException(f"None of these locators became visible: {xpaths}") from None


def safe_click(driver: WebDriver, xpaths: str | Iterable[str], timeout: float = PAGE_TIMEOUT) -> None:
    """Locate fresh, scroll into view, click; fall back to a JS click."""
    xp_list = [xpaths] if isinstance(xpaths, str) else list(xpaths)

    def attempt() -> None:
        wait_not_busy(driver, 10)
        el = find_visible(driver, xp_list, timeout)
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        try:
            wait(driver, 10).until(EC.element_to_be_clickable(el))
            el.click()
        except (ElementClickInterceptedException, TimeoutException):
            driver.execute_script("arguments[0].click();", el)

    retry_on_stale(attempt)
    time.sleep(POST_CLICK_PAUSE)


def button_xpath(text: str, scope: str = "") -> str:
    """Relative XPath for a button/link whose visible text contains `text`."""
    cond = _ci(".", text)
    return (
        f"{scope}//*[(self::button or self::a or self::input[@type='button'] "
        f"or self::span[@role='button']) and {cond}]"
    )


def select_option(driver: WebDriver, xpaths: list[str], wanted: str, label: str) -> None:
    """Pick an option by visible text, waiting for Angular to populate it."""
    def attempt() -> None:
        sel_el = find_visible(driver, xpaths)
        sel = Select(sel_el)
        texts = [o.text.strip() for o in sel.options]
        match = next((t for t in texts if t.lower() == wanted.lower()), None) or next(
            (t for t in texts if wanted.lower() in t.lower()), None
        )
        if match is None:
            raise NoSuchElementException(f"{label} option '{wanted}' not in {texts}")
        if sel.first_selected_option.text.strip() != match:
            sel.select_by_visible_text(match)  # fires change; Angular updates ng-model

    # The option list is filled asynchronously after the previous dropdown
    # changes, so retry NoSuchElement too, within a bounded time.
    deadline = time.time() + PAGE_TIMEOUT
    while True:
        try:
            retry_on_stale(attempt)
            return
        except NoSuchElementException:
            if time.time() > deadline:
                raise
            time.sleep(0.7)


def page_text(driver: WebDriver) -> str:
    try:
        return driver.find_element(By.TAG_NAME, "body").text.lower()
    except (StaleElementReferenceException, NoSuchElementException):
        return ""


def page_has(driver: WebDriver, phrases: Iterable[str]) -> Optional[str]:
    text = page_text(driver)
    return next((p for p in phrases if p in text), None)


# ===========================================================================
# 6. Login and navigation
# ===========================================================================


def manual_login(driver: WebDriver, login_url: str = LOGIN_URL) -> None:
    """Open the login page and pause for the human (CAPTCHA/OTP)."""
    driver.get(login_url)
    print("\n" + "=" * 70)
    print(" Log in to the GST portal in the Chrome window:")
    print("   username, password, CAPTCHA, OTP if asked.")
    print(" Then open  Services > Returns > Returns Dashboard.")
    print(" When the dashboard is on screen, come back here and press ENTER.")
    print("=" * 70)
    input("Press ENTER to start downloading... ")


def session_alive(driver: WebDriver) -> bool:
    url = driver.current_url.lower()
    if "/login" in url or "services/login" in url:
        return False
    return True


def open_dashboard(driver: WebDriver, dashboard_url: str = DASHBOARD_URL) -> None:
    """Make sure the Returns Dashboard search form is on screen."""
    if not _has_search_form(driver):
        driver.get(dashboard_url)
    if not session_alive(driver):
        raise SessionExpired("Redirected to the login page.")
    try:
        find_visible(driver, DROPDOWNS["fy"], PAGE_TIMEOUT)
    except TimeoutException:
        if not session_alive(driver):
            raise SessionExpired("Redirected to the login page.") from None
        raise TimeoutException("Returns Dashboard form did not appear.") from None
    wait_not_busy(driver)


def _has_search_form(driver: WebDriver) -> bool:
    for xp in DROPDOWNS["fy"]:
        try:
            if any(e.is_displayed() for e in driver.find_elements(By.XPATH, xp)):
                return True
        except WebDriverException:
            pass
    return False


def keep_alive(driver: WebDriver, dashboard_url: str = DASHBOARD_URL) -> None:
    """Cheap request that resets the portal's idle-logout timer."""
    try:
        driver.get(dashboard_url)
    except WebDriverException as exc:
        log.warning("Keep-alive request failed: %s", exc)


# ===========================================================================
# 7. Period selection
# ===========================================================================


def select_period(driver: WebDriver, fy: str, month: str, qrmp: bool = QRMP_FILER) -> None:
    """Set FY (+ quarter for QRMP) + period, click SEARCH, wait for redraw."""
    select_option(driver, DROPDOWNS["fy"], fy, "Financial Year")
    wait_not_busy(driver)
    if qrmp:
        select_option(driver, DROPDOWNS["quarter"], QUARTER_OF_MONTH[month], "Quarter")
        wait_not_busy(driver)
    select_option(driver, DROPDOWNS["period"], month, "Period")
    wait_not_busy(driver)

    safe_click(driver, SEARCH_BUTTON)
    # SEARCH redraws the cards in place (no page load). Wait for any card
    # button to appear after the overlay clears.
    wait_not_busy(driver)
    try:
        find_visible(driver, [button_xpath("DOWNLOAD"), button_xpath("VIEW"),
                              button_xpath("PREPARE OFFLINE")], PAGE_TIMEOUT)
    except TimeoutException:
        phrase = page_has(driver, NOT_FILED_PHRASES)
        if phrase:
            raise ReturnNotAvailable(f"Portal says '{phrase}'") from None
        raise


# ===========================================================================
# 8. Card lookup and file downloading
# ===========================================================================


def card_xpath(spec: ReturnSpec) -> str:
    """
    Nearest ancestor <div> (that holds a button) of a heading element whose
    own text carries one of the return's aliases. Purely text-relative, so it
    survives layout/class changes. Excluded aliases (GSTR-1A inside GSTR-1)
    are tested on the same heading text.
    """
    inc = " or ".join(_ci("text()", a) for a in spec.title_aliases)
    cond = f"({inc})"
    for ex in spec.exclude_aliases:
        cond += f" and not({_ci('text()', ex)})"
    heading = f"//*[not(self::script) and not(self::style) and {cond}]"
    holder = "ancestor::div[.//button or .//a[@role='button'] or .//a[contains(@class,'btn')]][1]"
    return f"{heading}/{holder}"


def find_card(driver: WebDriver, spec: ReturnSpec) -> WebElement:
    try:
        return find_visible(driver, [card_xpath(spec)], PAGE_TIMEOUT)
    except TimeoutException:
        phrase = page_has(driver, NOT_FILED_PHRASES)
        raise ReturnNotAvailable(
            f"No {spec.name} card found" + (f" (portal says '{phrase}')" if phrase else "")
        ) from None


def list_download_dir(directory: Path) -> set[str]:
    return {p.name for p in directory.iterdir() if p.is_file()}


def wait_for_download(directory: Path, before: set[str], timeout: float = DOWNLOAD_TIMEOUT) -> list[Path]:
    """
    Wait for new complete file(s). A file counts as complete when it has no
    partial suffix and its size has stopped changing.
    """
    deadline = time.time() + timeout
    sizes: dict[str, int] = {}
    stable: set[str] = set()
    while time.time() < deadline:
        names = list_download_dir(directory) - before
        partial = [n for n in names if n.lower().endswith(PARTIAL_SUFFIXES)]
        finished = [n for n in names if n not in partial]
        for n in finished:
            size = (directory / n).stat().st_size
            if sizes.get(n) == size and size > 0:
                stable.add(n)
            sizes[n] = size
        if finished and not partial and set(finished) == stable:
            return [directory / n for n in sorted(finished)]
        time.sleep(0.5)
    raise TimeoutException(f"No finished download appeared in {timeout}s")


def file_into_place(files: list[Path], base: Path, task: Task) -> list[str]:
    """Move + rename into DOWNLOAD_DIR/FY/Month/RETURN_FY_Month[_n].ext"""
    dest_dir = base / task.fy / task.month
    dest_dir.mkdir(parents=True, exist_ok=True)
    out: list[str] = []
    for i, src in enumerate(files):
        ext = src.suffix.lower()
        stem = f"{task.ret}_{task.fy}_{task.month}"
        dest = dest_dir / f"{stem}{ext}"
        n = 2
        while dest.exists():
            dest = dest_dir / f"{stem}_{n}{ext}"
            n += 1
        shutil.move(str(src), str(dest))
        out.append(str(dest))
    return out


def _check_state_after_click(driver: WebDriver) -> None:
    """Raise if the portal says 'in progress' or 'not filed'."""
    phrase = page_has(driver, IN_PROGRESS_PHRASES)
    if phrase:
        raise GenerationInProgress(f"Portal says '{phrase}'")
    phrase = page_has(driver, NOT_FILED_PHRASES)
    if phrase:
        raise ReturnNotAvailable(f"Portal says '{phrase}'")


def _first_present_click(driver: WebDriver, texts: list[str], timeout: float) -> Optional[str]:
    """Click the first button whose text matches (in priority order)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for text in texts:
            xp = button_xpath(text)
            try:
                els = [e for e in driver.find_elements(By.XPATH, xp) if e.is_displayed()]
            except StaleElementReferenceException:
                continue
            if els:
                safe_click(driver, xp, 10)
                return text
        _check_state_after_click(driver)
        time.sleep(0.5)
    return None


def download_one_format(driver: WebDriver, base: Path, spec: ReturnSpec, task: Task, fmt: str) -> list[str]:
    """
    Click the format's button(s) and collect the resulting file(s).
    Two shapes are handled:
      * direct:     one click starts the download
      * generate:   click GENERATE..., wait, click DOWNLOAD FILE
    """
    texts = spec.format_buttons.get(fmt)
    if not texts:
        raise ReturnNotAvailable(f"No button mapping for {spec.name} {fmt}")

    before = list_download_dir(base)
    clicked = _first_present_click(driver, texts, GENERATE_TIMEOUT)
    if clicked is None:
        _check_state_after_click(driver)
        raise ReturnNotAvailable(f"No {fmt} button found for {spec.name}")
    log.info("    clicked '%s'", clicked)

    is_generate = "generate" in clicked.lower()
    # Either the file arrives straight away, or the portal shows "in progress",
    # or a follow-up download link appears.
    end = time.time() + (GENERATE_TIMEOUT if is_generate else 8)
    while time.time() < end:
        new = list_download_dir(base) - before
        if new:  # a finished file or a .crdownload: hand over to wait_for_download
            break
        _check_state_after_click(driver)
        if is_generate:
            final = _first_present_click(driver, FINAL_DOWNLOAD_TEXTS, 1.5)
            if final:
                log.info("    clicked '%s'", final)
                break
        time.sleep(0.5)
    else:
        if is_generate:
            raise GenerationInProgress("Generate clicked but no download link appeared")

    files = wait_for_download(base, before)
    return file_into_place(files, base, task)


def download_return(driver: WebDriver, base: Path, task: Task, formats: list[str]) -> Result:
    """Download every requested format of one return for the current period."""
    spec = RETURN_SPECS[task.ret]
    saved: list[str] = []
    notes: list[str] = []
    in_progress: list[str] = []

    for fmt in formats:
        sub = Task(task.fy, task.month, task.ret, fmt)
        try:
            find_card(driver, spec)  # raises ReturnNotAvailable if the card is absent
            scope = card_xpath(spec)
            # Open the card's download area (portal may skip this step).
            opened = None
            for text in spec.card_buttons:
                xp = button_xpath(text, scope=f"({scope})[1]")
                if any(e.is_displayed() for e in driver.find_elements(By.XPATH, xp)):
                    safe_click(driver, xp)
                    opened = text
                    break
            if opened is None:
                raise ReturnNotAvailable(f"No {'/'.join(spec.card_buttons)} button on the {spec.name} card")
            wait_not_busy(driver)
            _check_state_after_click(driver)

            files = download_one_format(driver, base, spec, sub, fmt)
            saved.extend(files)
            log.info("    saved %s", ", ".join(Path(f).name for f in files))
        except ReturnNotAvailable as exc:
            notes.append(f"{fmt}: {exc}")
            log.warning("    %s %s skipped: %s", task.label(), fmt, exc)
        except GenerationInProgress as exc:
            in_progress.append(fmt)
            notes.append(f"{fmt}: {exc}")
            log.warning("    %s %s IN PROGRESS: %s", task.label(), fmt, exc)
        except (TimeoutException, NoSuchElementException, WebDriverException) as exc:
            notes.append(f"{fmt}: {type(exc).__name__}: {str(exc).splitlines()[0][:160]}")
            log.error("    %s %s failed: %s", task.label(), fmt, type(exc).__name__)
        finally:
            _back_to_dashboard(driver)

    if in_progress:
        return Result(Task(task.fy, task.month, task.ret, ",".join(in_progress)), "PENDING",
                      "; ".join(notes), saved)
    if saved:
        return Result(task, "DOWNLOADED", "; ".join(notes), saved)
    status = "SKIPPED" if notes and all("failed" not in n and "Error" not in n and "Timeout" not in n
                                         for n in notes) else "FAILED"
    return Result(task, status, "; ".join(notes))


def _back_to_dashboard(driver: WebDriver) -> None:
    """Return to the dashboard form: back button if present, else reload."""
    try:
        if _has_search_form(driver):
            return
        for text in BACK_TEXTS:
            xp = button_xpath(text)
            if any(e.is_displayed() for e in driver.find_elements(By.XPATH, xp)):
                safe_click(driver, xp, 10)
                wait_not_busy(driver)
                if _has_search_form(driver):
                    return
        driver.get(DASHBOARD_URL)
        find_visible(driver, DROPDOWNS["fy"], PAGE_TIMEOUT)
    except WebDriverException as exc:
        log.debug("back_to_dashboard problem: %s", exc)


# ===========================================================================
# 9. Orchestration
# ===========================================================================


def expand_tasks(targets: list[dict], returns: list[str]) -> list[Task]:
    tasks: list[Task] = []
    for tgt in targets:
        fy = tgt["financial_year"]
        for month in tgt["months"]:
            if month not in MONTH_ORDER:
                raise ValueError(f"Unknown month '{month}'. Use full names, e.g. 'April'.")
            for ret in returns:
                if ret not in RETURN_SPECS:
                    raise ValueError(f"Unknown return '{ret}'. Choose from {list(RETURN_SPECS)}.")
                tasks.append(Task(fy, month, ret))
    return tasks


def run_task(driver: WebDriver, base: Path, task: Task, formats: list[str], qrmp: bool,
             period_state: dict) -> Result:
    """One (FY, month, return). Re-selects the period only when it changed."""
    try:
        key = (task.fy, task.month)
        if period_state.get("key") != key or not _has_search_form(driver):
            open_dashboard(driver)
            select_period(driver, task.fy, task.month, qrmp)
            period_state["key"] = key
        return download_return(driver, base, task, formats)
    except ReturnNotAvailable as exc:
        period_state["key"] = None
        log.warning("  SKIP %s: %s", task.label(), exc)
        return Result(task, "SKIPPED", str(exc))
    except SessionExpired:
        raise
    except (TimeoutException, NoSuchElementException, WebDriverException) as exc:
        period_state["key"] = None
        log.error("  FAIL %s: %s", task.label(), type(exc).__name__)
        _back_to_dashboard(driver)
        return Result(task, "FAILED", f"{type(exc).__name__}: {str(exc).splitlines()[0][:200]}")


def wait_with_keepalive(driver: WebDriver, minutes: float) -> None:
    end = time.time() + minutes * 60
    last_ping = time.time()
    while time.time() < end:
        left = int(end - time.time())
        log.info("  waiting for portal to finish generating... %dm%02ds left", left // 60, left % 60)
        time.sleep(min(30, max(1, left)))
        if time.time() - last_ping >= SESSION_KEEPALIVE_EVERY:
            keep_alive(driver)
            last_ping = time.time()


def relogin_if_needed(driver: WebDriver) -> None:
    if not session_alive(driver):
        print("\nSession expired. Log in again, open the Returns Dashboard, then press ENTER.")
        driver.get(LOGIN_URL)
        input("Press ENTER once logged in... ")


def run(driver: WebDriver, base: Path, tasks: list[Task], formats_map: dict[str, list[str]],
        qrmp: bool) -> list[Result]:
    results: list[Result] = []
    pending: list[Task] = []
    period_state: dict = {}

    def process(batch: list[Task], retry: bool = False) -> None:
        for i, task in enumerate(batch, 1):
            fmts = (task.fmt.split(",") if (retry and task.fmt) else formats_map[task.ret])
            log.info("[%d/%d] %s", i, len(batch), task.label())
            while True:
                try:
                    res = run_task(driver, base, Task(task.fy, task.month, task.ret), fmts, qrmp, period_state)
                    break
                except SessionExpired:
                    period_state["key"] = None
                    relogin_if_needed(driver)
            if res.status == "PENDING":
                pending.append(res.task)
            results.append(res)

    process(tasks)

    rounds = 0
    while pending and PENDING_RETRY_AFTER_MINUTES > 0 and rounds < PENDING_MAX_ROUNDS:
        rounds += 1
        batch, pending[:] = list(pending), []
        log.info("%d file(s) still generating. Round %d/%d: waiting %d min.",
                 len(batch), rounds, PENDING_MAX_ROUNDS, PENDING_RETRY_AFTER_MINUTES)
        wait_with_keepalive(driver, PENDING_RETRY_AFTER_MINUTES)
        relogin_if_needed(driver)
        period_state["key"] = None
        # Drop earlier PENDING rows for these tasks; the retry supersedes them.
        keys = {(t.fy, t.month, t.ret) for t in batch}
        results[:] = [r for r in results if not (r.status == "PENDING"
                      and (r.task.fy, r.task.month, r.task.ret) in keys)]
        process(batch, retry=True)

    return results


def write_report(base: Path, results: list[Result]) -> Path:
    path = base / "results.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["financial_year", "month", "return", "status", "files", "detail"])
        for r in results:
            w.writerow([r.task.fy, r.task.month, r.task.ret, r.status, " | ".join(r.files), r.detail])
    return path


# ===========================================================================
# 10. CLI
# ===========================================================================


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Bulk download GSTR-1 / GSTR-2B / GSTR-3B.")
    p.add_argument("--dir", type=Path, default=DOWNLOAD_DIR, help="download folder (absolute)")
    p.add_argument("--returns", nargs="+", choices=list(RETURN_SPECS), default=RETURNS)
    p.add_argument("--fy", help="override TARGETS with one financial year, e.g. 2024-25")
    p.add_argument("--months", nargs="+", help="months for --fy (default: all 12)")
    p.add_argument("--qrmp", action="store_true", default=QRMP_FILER, help="QRMP filer (quarter dropdown)")
    p.add_argument("--chromedriver", help="path to a chromedriver (skips webdriver-manager)")
    p.add_argument("--no-login-pause", action="store_true", help="skip the Enter prompt (self-tests only)")
    p.add_argument("--login-url", default=LOGIN_URL)
    p.add_argument("--dashboard-url", default=DASHBOARD_URL)
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    global DASHBOARD_URL
    args = parse_args(argv)
    DASHBOARD_URL = args.dashboard_url
    base: Path = args.dir.expanduser().resolve()
    base.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout),
                  logging.FileHandler(base / "gst_downloader.log", encoding="utf-8")],
    )

    targets = TARGETS
    if args.fy:
        targets = [{"financial_year": args.fy, "months": args.months or MONTH_ORDER}]
    tasks = expand_tasks(targets, args.returns)
    formats_map = {r: FORMATS[r] for r in args.returns}
    log.info("%d download task(s) -> %s", len(tasks), base)

    driver = setup_driver(base, args.chromedriver)
    results: list[Result] = []
    try:
        if args.no_login_pause:
            driver.get(args.login_url)
        else:
            manual_login(driver, args.login_url)
        results = run(driver, base, tasks, formats_map, args.qrmp)
    except KeyboardInterrupt:
        log.warning("Interrupted by user.")
    finally:
        report = write_report(base, results)
        counts: dict[str, int] = {}
        for r in results:
            counts[r.status] = counts.get(r.status, 0) + 1
        log.info("Summary: %s", counts or "nothing processed")
        log.info("Report: %s", report)
        pend = [r for r in results if r.status == "PENDING"]
        if pend:
            log.warning("Still generating on the portal (re-run later for these): %s",
                        ", ".join(r.task.label() for r in pend))
        try:
            driver.quit()
        except WebDriverException:
            pass
    return 0 if all(r.status in ("DOWNLOADED", "SKIPPED") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
