require('dotenv').config();
const { scrapeProduct } = require('./scraper');

async function runTest() {
  // Allow passing product ID from CLI, default to 380
  const targetId = process.argv[2] ? parseInt(process.argv[2], 10) : 380;

  console.log('==================================================');
  console.log('🧪 Starting Playwright Headed Scraper Test');
  console.log(`Target: Mock Store Product #${targetId}`);
  console.log('Watch your screen! A Chromium window will open...');
  console.log('==================================================\n');

  // Test with headed: true so a browser pops up
  const result = await scrapeProduct(targetId, { headed: true });

  console.log('\n==================================================');
  console.log('📋 Test Execution Result:');
  console.log(JSON.stringify(result, null, 2));
  console.log('==================================================');

  if (result.success) {
    console.log('\n✅ Scraper successfully bypassed challenge and extracted live data!');
  } else {
    console.log('\n❌ Scraper encountered an issue:', result.errorMessage);
  }
}

runTest().catch(console.error);
