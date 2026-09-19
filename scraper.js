const { chromium } = require('playwright');

/**
 * Scrapes a single product's price and stock from INE's mock storefront.
 * Handles:
 * - Anti-scraping mouse-movement tracking & dwell time
 * - "Reveal price" button clicks
 * - Dynamic loading spinners and retry states
 * - Error handling with clean status codes
 * 
 * @param {number|string} productId - Mock store product ID (e.g. 380)
 * @param {object} options - { headed: boolean, maxRetries: number }
 * @returns {Promise<object>} Scrape result object
 */
async function scrapeProduct(productId, options = {}) {
  const isHeaded = options.headed ?? (process.env.HEADED === 'true');
  const maxRetries = options.maxRetries ?? 3;
  const targetUrl = `https://demo.inelabteamdev.com/product/${productId}`;

  const startTime = Date.now();
  let attempt = 0;
  let lastError = null;
  let browser = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      console.log(`[Scraper] Attempt ${attempt}/${maxRetries} for product #${productId} (Headed: ${isHeaded})`);

      // 1. Launch browser
      browser = await chromium.launch({
        headless: !isHeaded,
        slowMo: isHeaded ? 1000 : 0 // slight slowdown in headed mode so it is visible
      });

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      const page = await context.newPage();
      // 2. Navigate to product page
      // Use 'commit' so we don't hang if the mock store deliberately stalls asset loading
      const response = await page.goto(targetUrl, {
        waitUntil: 'commit',
        timeout: 35000
      });

      const httpStatus = response ? response.status() : null;
      if (httpStatus && httpStatus >= 400) {
        throw new Error(`HTTP ${httpStatus} while loading product page`);
      }

      // 2.5 Wait a moment for React to mount, then nuke cookie overlay immediately
      // 2.5 Nuke cookie overlay and keep it gone
      await page.evaluate(() => {
        // Remove existing overlays
        document.querySelectorAll('.cookie-overlay, [class*="cookie"], [class*="consent"]')
          .forEach(el => el.remove());

        // Watch for it coming back and remove it immediately
        const observer = new MutationObserver(() => {
          document.querySelectorAll('.cookie-overlay, [class*="cookie"], [class*="consent"]')
            .forEach(el => el.remove());
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }).catch(() => { });

      // 3. Locate the price block (wait for React to mount)
      const priceBlock = page.locator('.price-block').first();
      await priceBlock.waitFor({ state: 'visible', timeout: 25000 });

      await page.evaluate(() => {
        document.querySelectorAll('.cookie-overlay, .cookie-banner, [class*="cookie"], [class*="consent"]')
          .forEach(el => el.remove());
      }).catch(() => { });


      // 4. Use real Playwright mouse hover first, then synthetic events as backup
      const box = await priceBlock.boundingBox();
      if (box) {
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        // Real mouse move into element (triggers actual browser hover events)
        await page.mouse.move(centerX, centerY);
        await page.waitForTimeout(500);

        // Fire 50 real mouse moves with jitter
        for (let i = 0; i < 50; i++) {
          const jitterX = centerX + (Math.random() - 0.5) * 20;
          const jitterY = centerY + (Math.random() - 0.5) * 10;
          await page.mouse.move(jitterX, jitterY);
          await page.waitForTimeout(100);
        }

        // Return to center and dwell
        await page.mouse.move(centerX, centerY);
        await page.waitForTimeout(3000); // long dwell to satisfy minDwellMs
      }

      // 5. Remove overlay one more time right before clicking, then use real Playwright click
      await page.evaluate(() => {
        document.querySelectorAll('.cookie-overlay, [class*="cookie"], [class*="consent"]')
          .forEach(el => el.remove());
        // Also remove any element with high z-index covering the button
        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'absolute') &&
            parseInt(s.zIndex) > 100 &&
            !el.querySelector('button[aria-label="Reveal price"]')) {
            el.style.pointerEvents = 'none'; // disable pointer blocking without removing
          }
        });
      }).catch(() => { });

      // Use real Playwright click for isTrusted = true
      const revealButton = page.locator('button[aria-label="Reveal price"]').first();
      if (await revealButton.count() > 0) {
        await revealButton.click({ force: true }); // force: true bypasses overlay check
        console.log('[Scraper] Clicked "Reveal price" via Playwright (trusted)');
      }
      // 6. Wait for spinner and retrying phase to completely settle
      console.log('[Scraper] Waiting for price challenge to settle...');

      await page.waitForFunction(() => {
        const priceBlock = document.querySelector('.price-block');
        if (!priceBlock) return false;

        const text = priceBlock.textContent || '';
        const hasSpinner = !!priceBlock.querySelector('.spinner');
        const isRetrying = text.includes('Retrying') || text.includes('Loading');

        // Keep waiting if it is actively loading or retrying with upstream 500/503
        if (hasSpinner || isRetrying) return false;

        // Ready when .price-main exists or permanent error message is displayed
        const hasPriceMain = !!priceBlock.querySelector('.price-main');
        const hasPermanentError = text.includes("Couldn’t load");
        return hasPriceMain || hasPermanentError;
      }, { timeout: 45000 });

      const priceBlockText = await priceBlock.textContent();
      const priceBlockHtml = await priceBlock.innerHTML();

      if (priceBlockText.includes("Couldn’t load") || priceBlockText.includes("Price hidden")) {
        throw new Error(`Store returned permanent failure: ${priceBlockText.trim()}`);
      }

      // 7. Extract real visible numeric price (Handles character-split spans like ["₹", "1", "8", ",", "3", "5", "3"])
      const realPrice = await page.evaluate(() => {
        const priceMain = document.querySelector('.price-main');
        if (!priceMain) return null;

        const spans = Array.from(priceMain.querySelectorAll('span'));

        // Filter for visible, non-strikethrough spans that belong to the active price
        const activeSpans = spans.filter(span => {
          const style = window.getComputedStyle(span);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (span.getAttribute('aria-hidden') === 'true') return false;

          const decoration = style.textDecorationLine || style.textDecoration || '';
          if (decoration.includes('line-through')) return false;

          const text = span.textContent.replace(/\u00a0/g, ' ').trim();
          if (text.includes('% off') || text.toLowerCase().includes('deal price') ||
            text.includes('attempt') || text.includes('Updating')) return false;

          return true;
        });

        // Concatenate text and remove ALL invisible zero-width spaces (\u200b, \u200c, \u200d, \ufeff, etc.)
        let combinedText = activeSpans
          .map(s => s.textContent)
          .join('')
          .replace(/[\u200b-\u200d\ufeff\u00a0]/g, '')
          // Convert fullwidth digits ０-９ to normal 0-9
          .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
          // Convert fullwidth comma and period
          .replace(/，/g, ',').replace(/．/g, '.')
          .trim();
        // Matches: ₹18,353 or ₹29.555,00 or Rs. 13,950.00
        const match = combinedText.match(/(?:₹|Rs\.?|INR)?\s*([\d.,]+)/i);
        if (match) {
          let numStr = match[1];

          // If it ends with decimals like 29.555,00 or 18,353.00
          if (numStr.includes(',') && numStr.includes('.')) {
            if (numStr.lastIndexOf(',') > numStr.lastIndexOf('.')) {
              // 29.555,00 -> 29555.00
              numStr = numStr.replace(/\./g, '').replace(',', '.');
            } else {
              // 18,353.00 -> 18353.00
              numStr = numStr.replace(/,/g, '');
            }
          } else if (numStr.includes(',')) {
            // 14,182 → 14182
            numStr = numStr.replace(/,/g, '');
          } else {
            // Remove any stray periods
            numStr = numStr.replace(/\./g, '');
          }

          const val = parseFloat(numStr);
          if (!isNaN(val) && val > 0) return val;
        }

        return null;
      });

      let price = realPrice;
      if (price === null || isNaN(price)) {
        throw new Error(`Could not parse valid real selling price from: "${priceBlockText}"`);
      }

      // 8. Extract stock information
      const stockInfo = await page.evaluate(() => {
        const block = document.querySelector('.price-block');
        if (!block) return { stockStatus: 'UNKNOWN', stockCount: null };

        // Clean zero width spaces from text
        const text = block.textContent.replace(/[\u200b-\u200d\ufeff\u00a0]/g, ' ').toLowerCase();

        if (text.includes('out of stock')) {
          return { stockStatus: 'OUT_OF_STOCK', stockCount: 0 };
        }

        // Match "152 in stock", "88 left", "in stock · 50 left"
        const countMatch = text.match(/(\d+)\s*(?:in stock|left)/i) || text.match(/(?:in stock|left)[^\d]*(\d+)/i);
        if (countMatch) {
          return {
            stockStatus: 'IN_STOCK',
            stockCount: parseInt(countMatch[1], 10)
          };
        }

        if (text.includes('in stock')) {
          return { stockStatus: 'IN_STOCK', stockCount: null };
        }

        return { stockStatus: 'UNKNOWN', stockCount: null };
      });

      const stockStatus = stockInfo.stockStatus;
      const stockCount = stockInfo.stockCount;

      const durationMs = Date.now() - startTime;
      console.log(`[Scraper] SUCCESS: Price = ₹${price}, Stock = ${stockStatus} (${stockCount ?? 'N/A'}), Duration = ${durationMs}ms`);

      await browser.close();

      return {
        success: true,
        productId,
        price,
        currency: 'INR',
        stockStatus,
        stockCount,
        attempts: attempt,
        status: attempt > 1 ? 'RETRIED' : 'SUCCESS',
        durationMs,
        httpStatus: 200,
        errorMessage: null,
        scrapedAt: new Date().toISOString()
      };

    } catch (err) {
      lastError = err.message;
      console.warn(`[Scraper] Attempt ${attempt} failed: ${lastError}`);

      if (browser) {
        await browser.close().catch(() => { });
      }

      // If we still have retries left, wait 1.5s before retrying
      if (attempt < maxRetries) {
        console.log(`[Scraper] Retrying in 1.5 seconds...`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  // If all retries failed:
  const durationMs = Date.now() - startTime;
  console.error(`[Scraper] FAILED after ${attempt} attempts: ${lastError}`);

  return {
    success: false,
    productId,
    price: null,
    currency: 'INR',
    stockStatus: 'UNKNOWN',
    stockCount: null,
    attempts: attempt,
    status: 'FAILED',
    durationMs,
    httpStatus: 500,
    errorMessage: lastError,
    scrapedAt: new Date().toISOString()
  };
}

module.exports = { scrapeProduct };
