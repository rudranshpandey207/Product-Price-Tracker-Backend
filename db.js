const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[Database Error] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

// Create Supabase client using Service Role key for backend operations (bypasses RLS)
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});

/**
 * Fetch all active tracked products with their latest price snapshot
 */
async function getTrackedProducts() {
  const { data: products, error } = await supabase
    .from('products')
    .select(`
      *,
      price_history (
        price,
        currency,
        stock_status,
        stock_count,
        scraped_at
      )
    `)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Format so each product has its latest price info cleanly attached
  return (products || []).map(p => {
    const history = p.price_history || [];
    // Sort descending by scraped_at to pick the most recent
    history.sort((a, b) => new Date(b.scraped_at) - new Date(a.scraped_at));
    const latest = history[0] || null;

    return {
      id: p.id,
      storeId: p.store_id,
      name: p.name,
      slug: p.slug,
      brand: p.brand,
      category: p.category,
      sku: p.sku,
      description: p.description,
      isActive: p.is_active,
      createdAt: p.created_at,
      latestPrice: latest ? latest.price : null,
      latestStockStatus: latest ? latest.stock_status : 'UNKNOWN',
      latestStockCount: latest ? latest.stock_count : null,
      lastScrapedAt: latest ? latest.scraped_at : null
    };
  });
}

/**
 * Add a new product to be tracked
 */
async function addTrackedProduct(product) {
  const { data, error } = await supabase
    .from('products')
    .insert([
      {
        store_id: product.storeId,
        name: product.name,
        slug: product.slug,
        brand: product.brand,
        category: product.category,
        sku: product.sku,
        description: product.description,
        is_active: true
      }
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Remove (or deactivate) a tracked product
 */
async function removeTrackedProduct(productId) {
  const { data, error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .select();

  if (error) throw error;
  return data;
}

/**
 * Record a valid price snapshot into price_history
 * NOTE: Never called on failure (preserves clean history)
 */
async function recordPriceSnapshot(productId, priceData) {
  const { data, error } = await supabase
    .from('price_history')
    .insert([
      {
        product_id: productId,
        price: priceData.price,
        currency: priceData.currency || 'INR',
        stock_status: priceData.stockStatus,
        stock_count: priceData.stockCount,
        scraped_at: priceData.scrapedAt || new Date().toISOString()
      }
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Record an honest scrape attempt log into scrape_logs
 * Records SUCCESS, RETRIED, or FAILED
 */
async function recordScrapeLog(productId, logData) {
  const { data, error } = await supabase
    .from('scrape_logs')
    .insert([
      {
        product_id: productId,
        status: logData.status,
        attempts: logData.attempts,
        duration_ms: logData.durationMs,
        http_status: logData.httpStatus,
        error_message: logData.errorMessage,
        created_at: logData.scrapedAt || new Date().toISOString()
      }
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get price history for a specific product
 */
async function getProductPriceHistory(productId) {
  const { data, error } = await supabase
    .from('price_history')
    .select('*')
    .eq('product_id', productId)
    .order('scraped_at', { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Get scrape logs for a specific product
 */
async function getProductScrapeLogs(productId) {
  const { data, error } = await supabase
    .from('scrape_logs')
    .select('*')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  getTrackedProducts,
  addTrackedProduct,
  removeTrackedProduct,
  recordPriceSnapshot,
  recordScrapeLog,
  getProductPriceHistory,
  getProductScrapeLogs
};
