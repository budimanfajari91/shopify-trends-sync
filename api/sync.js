import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    // 1. Ambil data dari Trends NZ (Gunakan URL tanpa ekstensi .json)
    const trendsRes = await fetch('https://au.api.trends.nz/api/v1/products', {
      headers: {
        'Authorization': TRENDS_TOKEN,
        'Accept': 'application/json'
      }
    });

    // Cek jika respon Trends bukan 200 OK
    if (!trendsRes.ok) {
      const errorText = await trendsRes.text();
      return res.status(trendsRes.status).json({
        success: false,
        source: 'Trends NZ API Error',
        status: trendsRes.status,
        details: errorText.substring(0, 300)
      });
    }

    const trendsData = await trendsRes.json();
    let updatedCount = 0;

    // 2. Loop & update harga ke Shopify jika data produk ada
    if (trendsData && (trendsData.products || Array.isArray(trendsData))) {
      const productList = trendsData.products || trendsData;

      for (const item of productList) {
        if (!item.sku || !item.price) continue;

        // Cari Variant ID di Shopify via REST API
        const shopifySearch = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/variants.json?sku=${item.sku}`, {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_TOKEN,
            'Content-Type': 'application/json'
          }
        });

        if (!shopifySearch.ok) continue;

        const shopifyData = await shopifySearch.json();
        if (shopifyData.variants && shopifyData.variants.length > 0) {
          const variantId = shopifyData.variants[0].id;

          // Update harga variant di Shopify
          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/variants/${variantId}.json`, {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              variant: {
                id: variantId,
                price: item.price
              }
            })
          });

          updatedCount++;
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: `Berhasil sinkronisasi ${updatedCount} produk.`
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}