import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    // 1. Ambil data dari trends.nz
    const trendsRes = await fetch('https://nz.api.trends.nz/api/v1/products.json', {
      headers: {
        'Authorization': `Bearer ${TRENDS_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    if (!trendsRes.ok) {
      throw new Error(`Trends API Error: ${trendsRes.statusText}`);
    }

    const trendsData = await trendsRes.json();
    let updatedCount = 0;

    // 2. Loop & update harga ke Shopify jika SKU cocok
    // Catatan: Sesuaikan field 'products' & 'price' dengan struktur JSON aktual dari trends.nz
    if (trendsData && trendsData.products) {
      for (const item of trendsData.products) {
        if (!item.sku || !item.price) continue;

        // Cari Variant ID di Shopify via REST API berdasarkan SKU
        const shopifySearch = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/variants.json?sku=${item.sku}`, {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_TOKEN,
            'Content-Type': 'application/json'
          }
        });

        const searchData = await shopifySearch.json();

        if (searchData.variants && searchData.variants.length > 0) {
          const variantId = searchData.variants[0].id;

          // Update harga varian tersebut
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
      message: `Sync berhasil. Total ${updatedCount} harga produk diperbarui.`
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}