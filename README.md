# Product Price Tracker — Backend

A Node.js/Express backend that scrapes product prices from INE's mock storefront on a schedule and stores history in Supabase (PostgreSQL).

## Live URLs
- **Frontend:** https://product-price-tracker-frontend.vercel.app/
- **Backend:** https://product-price-tracker-backend-kaqx.onrender.com

## Tech Stack
- **Runtime:** Node.js + Express
- **Scraping:** Playwright (Chromium headless)
- **Database:** Supabase (PostgreSQL)
- **Scheduling:** cron-job.org (external cron)
- **Hosting:** Render (free tier)

## Setup Instructions

### 1. Clone the repo
```bash
git clone https://github.com/rudranshpandey207/Product-Price-Tracker.git
cd Product-Price-Tracker
```

### 2. Install dependencies
```bash
npm install
npx playwright install chromium
```

### 3. Create `.env` file
SUPABASE_URL=your-supabase-project-url
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
PORT=3001


### 4. Set up Supabase tables
Run this SQL in your Supabase SQL Editor:

```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT,
  brand TEXT,
  category TEXT,
  sku TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price NUMERIC(10, 2) NOT NULL,
  currency TEXT DEFAULT 'INR',
  stock_status TEXT DEFAULT 'UNKNOWN',
  stock_count INTEGER,
  scraped_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scrape_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER DEFAULT 1,
  duration_ms INTEGER,
  http_status INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 5. Run locally
```bash
node index.js
```

### 6. Run scraper in headed mode
```bash
node test-scraper.js 380
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /products | List all tracked products with latest price |
| POST | /products | Add a product to track |
| DELETE | /products/:id | Remove a tracked product |
| GET | /products/:id/history | Price history for a product |
| GET | /products/:id/logs | Scrape logs for a product |
| POST | /scrape/run | Trigger a scrape run (called by cron job) |
| GET | /search?q= | Search mock store products by name/brand/category |

## Scraping Schedule
- Every **2 hours** via cron-job.org hitting `POST /scrape/run`
- A keep-alive ping hits `GET /health` every **10 minutes** to prevent Render free tier from sleeping

## Environment Variables

| Variable | Description |
|----------|-------------|
| SUPABASE_URL | Your Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key (bypasses RLS) |
| PORT | Server port (default 3001) |
| PLAYWRIGHT_BROWSERS_PATH | Path for Playwright browser binaries on Render |

## Design Note — How Scraping Reliability Was Achieved

### Anti-scraping mechanisms encountered and solved

**1. Mouse movement tracker**
The store runs a client-side JavaScript class that records mouse coordinates and dwell time over the price area. It requires a minimum number of moves and minimum hover duration before the price is revealed. We reverse-engineered this from the site's bundled JS and satisfy it by generating 50 organic Playwright mouse movements with random jitter over the price block, followed by a 3-second dwell wait.

**2. Cookie consent overlay**
A `.cookie-overlay` element intercepts all pointer events and blocks button clicks. We handle this by injecting a MutationObserver via `page.evaluate()` immediately after navigation. The observer removes the overlay and watches for React re-rendering it, removing it again instantly each time.

**3. Trusted click requirement**
The store's server-side validation checks `isTrusted` on the click event. A plain `btn.click()` via JavaScript sets `isTrusted: false` and the server returns `challenge_failed`. We use Playwright's `click({ force: true })` which generates a real browser input event with `isTrusted: true` while bypassing overlay blocking.

**4. Honeypot prices and strikethrough MRP**
The page contains hidden spans and crossed-out MRP prices designed to trap naive scrapers. We filter these out by checking `display: none`, `visibility: hidden`, `aria-hidden`, and `text-decoration: line-through` via `getComputedStyle`.

**5. Fullwidth Unicode digits**
Prices occasionally render with fullwidth Unicode characters (e.g. `１４,１８２` instead of `14,182`). We normalise these by shifting character codes by `0xFEE0`.

**6. Zero-width spaces**
Price strings contain invisible zero-width space characters that break naive regex matching. We strip these before parsing.

**7. Retries and honest logging**
Every scrape attempt is logged to `scrape_logs` with status (`SUCCESS`, `RETRIED`, or `FAILED`), attempt count, duration, and error message. Price snapshots are written only on success — never on failure. Up to 3 retries with 1.5s delay between attempts.

### Trade-offs

- **Headless browser over HTTP fetching:** The price requires JavaScript execution, mouse interaction, and trusted click events — lightweight HTTP fetching is impossible here.
- **External cron over always-on loop:** Render's free tier sleeps after inactivity. An always-on `setInterval` would stop working when the instance sleeps. cron-job.org triggers scrapes reliably from outside.
- **MutationObserver for overlay:** Removing the overlay once wasn't enough since React re-renders it. A MutationObserver watches for it coming back and removes it instantly.
- **`force: true` on Playwright click:** Needed to bypass the overlay while keeping `isTrusted: true`, which a JS `btn.click()` cannot provide.

### What AI got wrong on the first attempt
1. Used `offsetWidth === 0` to filter invisible spans — incorrectly filtered all spans in headless Playwright since flex children report zero dimensions differently than in a real browser.
2. Used `btn.click()` via JavaScript which sets `isTrusted: false` and fails server-side validation — switched to Playwright `click({ force: true })`.
3. Removed the cookie overlay only once — React re-rendered it immediately, blocking subsequent clicks — fixed with MutationObserver.
4. Placed cookie removal too late (after price block appeared) — moved it to immediately after navigation with a 2-second wait.
5. Mouse movement loop had too few moves and too short dwell time for headless mode — increased to 50 moves and 3-second dwell.