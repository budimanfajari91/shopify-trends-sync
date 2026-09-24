import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    const authHeader = TRENDS_TOKEN?.startsWith('Bearer') 
      ? TRENDS_TOKEN 
      : `Bearer ${TRENDS_TOKEN}`;

    // 1. Ambil data dari Trends NZ
    const trendsRes = await fetch('https://au.api.trends.nz/api/v1/products.json', {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });

    const trendsData = await trendsRes.json();
    const productList = Array.isArray(trendsData) 
      ? trendsData 
      : (trendsData.products || trendsData.data || []);

    if (productList.length === 0) {
      return res.status(200).json({
        debug_step: "1. Ambil Data Trends",
        message: "Data produk dari Trends.nz kosong.",
        raw_response: trendsData
      });
    }

    // Ambil sampel produk pertama dari Trends NZ
    const sampleItem = productList[0];
    const sampleSku = sampleItem.sku || sampleItem.code || sampleItem.product_code;

    // 2. Cek Pencarian ke Shopify
    const graphqlQuery = {
      query: `
        query {
          productVariants(first: 5, query: "sku:${sampleSku}") {
            edges {
              node {
                id
                sku
                price
              }
            }
          }
        }
      `
    };

    const shopifySearch = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(graphqlQuery)
    });

    const shopifyData = await shopifySearch.json();

    // Kembalikan laporan diagnostik lengkap ke browser
    return res.status(200).json({
      debug_step: "Diagnostik Pencocokan SKU",
      total_trends_products: productList.length,
      sample_trends_item: {
        raw_keys_available: Object.keys(sampleItem),
        detected_sku: sampleSku,
        detected_price: sampleItem.price || sampleItem.wholesale_price || sampleItem.pricing
      },
      shopify_search_result: shopifyData
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}