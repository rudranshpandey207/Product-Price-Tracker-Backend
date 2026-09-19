const express = require('express');
const cors = require('cors');
require('dotenv').config();

const {
    getTrackedProducts,
    addTrackedProduct,
    removeTrackedProduct,
    recordPriceSnapshot,
    recordScrapeLog,
    getProductPriceHistory,
    getProductScrapeLogs
} = require('./db');
const { scrapeProduct } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

// Health check — cron-job.org can also ping this to keep Render awake
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /products — list all tracked products with latest price
app.get('/products', async (req, res) => {
    try {
        const products = await getTrackedProducts();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /products — add a product to track
// Body: { storeId, name, slug, brand, category, sku, description }
app.post('/products', async (req, res) => {
    try {
        const product = await addTrackedProduct(req.body);
        res.status(201).json(product);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Product already being tracked' });
        }
        res.status(500).json({ error: err.message });
    }
});

// DELETE /products/:id — stop tracking a product
app.delete('/products/:id', async (req, res) => {
    try {
        await removeTrackedProduct(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /products/:id/history — price history for a product
app.get('/products/:id/history', async (req, res) => {
    try {
        const history = await getProductPriceHistory(req.params.id);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /products/:id/logs — scrape logs for a product
app.get('/products/:id/logs', async (req, res) => {
    try {
        const logs = await getProductScrapeLogs(req.params.id);
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /scrape/run — scrape all tracked products (hit by cron job every 2 hours)
app.post('/scrape/run', async (req, res) => {
    // Respond immediately so the cron job doesn't time out
    res.json({ status: 'started', time: new Date().toISOString() });

    try {
        const products = await getTrackedProducts();
        console.log(`[Cron] Starting scrape run for ${products.length} products`);

        for (const product of products) {
            const result = await scrapeProduct(product.storeId);

            // Always record the scrape log (success or failure)
            await recordScrapeLog(product.id, {
                status: result.status,
                attempts: result.attempts,
                durationMs: result.durationMs,
                httpStatus: result.httpStatus,
                errorMessage: result.errorMessage,
                scrapedAt: result.scrapedAt
            });

            // Only record price snapshot on success
            if (result.success) {
                await recordPriceSnapshot(product.id, {
                    price: result.price,
                    currency: result.currency,
                    stockStatus: result.stockStatus,
                    stockCount: result.stockCount,
                    scrapedAt: result.scrapedAt
                });
                console.log(`[Cron] ✅ ${product.name} — ₹${result.price}`);
            } else {
                console.log(`[Cron] ❌ ${product.name} — ${result.errorMessage}`);
            }
        }

        console.log('[Cron] Scrape run complete');
    } catch (err) {
        console.error('[Cron] Run failed:', err.message);
    }
});
// GET /search?q=... — search mock store products by name (fetches all 1000, filters locally)
app.get('/search', async (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ error: 'Missing query param ?q=' });

    try {
        const allItems = [];
        const pageSize = 50; // max out page size to minimize requests
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
            const url = `https://demo.inelabteamdev.com/api/catalog?page=${page}&pageSize=${pageSize}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status}`);
            const data = await response.json();
            totalPages = data.pages;
            allItems.push(...data.items);
            page++;
        }

        // Filter by name, brand, or category
        const results = allItems.filter(item =>
            item.name.toLowerCase().includes(q) ||
            item.brand.toLowerCase().includes(q) ||
            item.category.toLowerCase().includes(q)
        );

        res.json({ query: q, total: results.length, items: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
});