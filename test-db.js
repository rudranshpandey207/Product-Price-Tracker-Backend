require('dotenv').config();
const { 
  getTrackedProducts, 
  addTrackedProduct, 
  recordPriceSnapshot, 
  recordScrapeLog, 
  getProductPriceHistory, 
  getProductScrapeLogs,
  removeTrackedProduct
} = require('./db');

async function testDatabase() {
  console.log('==================================================');
  console.log('🔌 Testing Supabase PostgreSQL Connection...');
  console.log('==================================================\n');

  try {
    // 1. Test fetching products
    console.log('1. Querying current tracked products...');
    const initialProducts = await getTrackedProducts();
    console.log(`✅ Success! Currently tracking: ${initialProducts.length} products.`);

    // 2. Add product 380 as tracked
    console.log('\n2. Adding Product #380 (Vantablack Hardshell Case Lite)...');
    let product;
    try {
      product = await addTrackedProduct({
        storeId: 380,
        name: 'Vantablack Hardshell Case Lite',
        slug: 'vantablack-hardshell-case-lite',
        brand: 'Vantablack',
        category: 'Bags',
        sku: 'VAN-10380',
        description: 'Dependable bags pick'
      });
      console.log('✅ Added product:', product.id, product.name);
    } catch (e) {
      if (e.message?.includes('duplicate key') || e.code === '23505') {
        console.log('ℹ️ Product #380 is already in database, fetching existing row...');
        const prods = await getTrackedProducts();
        product = prods.find(p => p.storeId === 380);
      } else {
        throw e;
      }
    }

    // 3. Record a test price snapshot
    console.log('\n3. Inserting test price snapshot (₹13,950)...');
    const snapshot = await recordPriceSnapshot(product.id, {
      price: 13950,
      currency: 'INR',
      stockStatus: 'IN_STOCK',
      stockCount: 22,
      scrapedAt: new Date().toISOString()
    });
    console.log('✅ Price snapshot inserted with ID:', snapshot.id);

    // 4. Record a scrape audit log
    console.log('\n4. Inserting scrape audit log (SUCCESS)...');
    const log = await recordScrapeLog(product.id, {
      status: 'SUCCESS',
      attempts: 1,
      durationMs: 6700,
      httpStatus: 200,
      errorMessage: null,
      scrapedAt: new Date().toISOString()
    });
    console.log('✅ Scrape log recorded with ID:', log.id);

    // 5. Query back history and logs
    console.log('\n5. Verifying data retrieval...');
    const history = await getProductPriceHistory(product.id);
    const logs = await getProductScrapeLogs(product.id);
    console.log(`✅ Retrieved ${history.length} price points and ${logs.length} scrape log entries.`);

    console.log('\n==================================================');
    console.log('🎉 ALL SUPABASE DATABASE TESTS PASSED!');
    console.log('==================================================');

  } catch (err) {
    console.error('\n❌ Database Connection / Operation Failed:');
    console.error(err);
  }
}

testDatabase();
