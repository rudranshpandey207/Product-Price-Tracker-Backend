# Design Note — Product Price Tracker

## How Scraping Reliability Was Achieved

### The Core Challenge
INE's mock storefront is deliberately designed to resist automated scraping. It uses multiple client-side and server-side mechanisms to detect and block scrapers. A simple HTTP fetch of the page HTML returns nothing useful — the price is never in the initial HTML. It only appears after JavaScript executes, mouse interaction is detected, and a server-side challenge is passed.

This made Playwright (headless Chromium) the only viable option.

---

### Anti-Scraping Mechanisms Encountered and How We Solved Each One

**1. Mouse Movement Tracker**
The store runs a client-side JavaScript class (reverse-engineered from the site's bundled JS) that records mouse coordinates and dwell time over the price area. It maintains a rolling buffer of up to 40 mouse positions and tracks when the mouse first entered the price area (`hoverAt`). The price reveal button stays disabled until:
- At least `minMoves` mouse movements have been recorded
- At least `minDwellMs` milliseconds have passed since `hoverAt`

**Solution:** We generate 50 organic Playwright mouse movements with random jitter (`±20px` on X, `±10px` on Y) over the price block center, spaced 100ms apart, followed by a 3-second stationary dwell. This satisfies both the move count and dwell time requirements.

**2. Cookie Consent Overlay**
A `.cookie-overlay` element sits on top of the entire page with a high z-index and intercepts all pointer events. This blocked Playwright's button click entirely — the element was visible and enabled but the click kept timing out because the overlay was on top.

**Solution:** We inject a `MutationObserver` via `page.evaluate()` immediately after navigation (before the price block even loads). The observer removes `.cookie-overlay` and any consent-related elements instantly whenever React re-renders them. Removing the overlay once wasn't enough — React kept re-adding it — so the observer watches the DOM continuously.

**3. Server-Side Trusted Click Validation**
Even after the mouse tracker was satisfied and the overlay removed, clicking the Reveal Price button via JavaScript (`btn.click()`) returned `challenge_failed` from the server. The reason: JavaScript-dispatched click events have `isTrusted: false`. The store's backend checks this flag and rejects untrusted clicks.

**Solution:** We use Playwright's `revealButton.click({ force: true })`. The `force: true` parameter bypasses Playwright's own overlay detection (so it doesn't re-check for blocking elements), but crucially it still generates a real browser input event with `isTrusted: true` — which the server accepts.

**4. Honeypot Prices and Strikethrough MRP**
The `.price-main` block contains multiple price values:
- The real selling price (visible, normal text)
- The MRP / original price (strikethrough, `text-decoration: line-through`)
- Hidden honeypot spans (`display: none`, `aria-hidden: true`) with fake prices designed to trap scrapers that read raw text

**Solution:** We filter spans using `window.getComputedStyle()` to check `display`, `visibility`, `opacity`, `aria-hidden`, and `textDecorationLine`. Only spans that pass all checks are considered candidates for the real price.

**5. Fullwidth Unicode Digits**
Prices occasionally render using fullwidth Unicode characters — for example `１４,１８２` instead of `14,182`. Standard regex and `parseFloat` cannot parse these.

**Solution:** We normalise fullwidth digits by shifting their character codes: `c.charCodeAt(0) - 0xFEE0` converts each fullwidth digit to its ASCII equivalent before parsing.

**6. Zero-Width Spaces**
Price text contains invisible Unicode characters (`\u200b`, `\u200c`, `\u200d`, `\ufeff`, `\u00a0`) injected between digits. These break string matching and regex even when the visible text looks correct.

**Solution:** We strip all zero-width and non-breaking space characters from the concatenated price text before running any regex or parse operations.

**7. Dynamic Loading States**
The price block cycles through several states after the button is clicked: a loading spinner, a "Retrying" state (when the store's upstream is slow), and finally either the price or a permanent error. Scraping too early returns incomplete data.

**Solution:** We use `page.waitForFunction()` to poll the DOM until the spinner is gone, no "Loading" or "Retrying" text is present, and either `.price-main` exists or a permanent error message appears. Only then do we attempt to extract the price.

---

### Trade-offs Made

**Headless browser over lightweight HTTP fetching**
The assignment suggests preferring lightweight HTTP fetching where possible. We evaluated this — the price is never present in the initial HTML response, requires JavaScript execution, mouse interaction, and a trusted click event. There is no way to obtain the price without a full browser. Playwright was the only option.

**External cron over always-on scheduler**
Render's free tier automatically sleeps instances after 15 minutes of inactivity. An `setInterval` inside the Node process would stop firing when the instance sleeps. We use cron-job.org to trigger `POST /scrape/run` every 2 hours from outside — this wakes the instance if needed and guarantees scheduled execution regardless of sleep state. A second cron job pings `GET /health` every 10 minutes to keep the instance warm between scrape runs.

**Sequential scraping over parallel**
We scrape products one at a time rather than in parallel. Parallel scraping would be faster but risks hitting the store's rate limits or triggering bot detection from multiple simultaneous browser sessions. Sequential scraping is slower but reliable across many unattended runs.

**Honest failure logging over silent retries**
Every scrape attempt — success or failure — is recorded in `scrape_logs`. Price snapshots are only written on success. This means the price history is always accurate, and failures are visible and auditable rather than hidden.

---

### What AI Got Wrong on the First Attempt

**1. `offsetWidth === 0` filter**
The initial price extraction code filtered out spans where `offsetWidth === 0 || offsetHeight === 0`, reasoning that invisible elements would have zero dimensions. In headless Playwright, flex and grid children often report zero dimensions even when visually rendered — this filter eliminated all valid price spans and returned null every time. Fix: removed the dimension check entirely and relied only on `getComputedStyle` visibility properties.

**2. JavaScript `btn.click()` for the reveal button**
The first approach used `page.evaluate(() => btn.click())` to bypass the cookie overlay. This worked locally in some cases but consistently returned `challenge_failed` in production because `isTrusted` was `false`. Fix: switched to Playwright's native `click({ force: true })` which preserves `isTrusted: true`.

**3. Single overlay removal**
The first cookie overlay fix called `page.evaluate()` once to remove the overlay element. React re-rendered it within milliseconds, blocking the next click. Fix: replaced the one-time removal with a `MutationObserver` that watches `document.body` and removes overlay elements instantly whenever they reappear.

**4. Late overlay removal timing**
The overlay removal was originally placed after `priceBlock.waitFor()` — by which point the overlay had already been blocking interactions for several seconds. Fix: moved the MutationObserver injection to immediately after `page.goto()`, before any other interaction.

**5. Insufficient mouse movement in headless mode**
The initial mouse simulation used 5 movements spaced 100ms apart. In headless mode, this was not enough to satisfy the tracker's `minMoves` requirement and the dwell time was too short. Fix: increased to 50 movements and added a 3-second dwell after the final position.