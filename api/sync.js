import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    // Membersihkan URL toko jika user tidak sengaja memasukkan https://
    let SHOPIFY_STORE = (process.env.SHOPIFY_STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
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

    if (!trendsRes.ok) {
      return res.status(trendsRes.status).json({ success: false, message: 'Gagal mengambil data Trends NZ' });
    }

    const trendsData = await trendsRes.json();
    const productList = Array.isArray(trendsData) 
      ? trendsData 
      : (trendsData.products || trendsData.data || []);

    let updatedCount = 0;
    let skippedCount = 0;

    // 2. Loop produk dari Trends NZ
    for (const item of productList) {
      // Trends menggunakan field 'code' untuk SKU
      const sku = item.code || item.sku;
      
      // Ambil harga kuantitas pertama dari array 'pricing.prices'
      let price = null;
      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        price = item.pricing.prices[0].price; // Mengambil harga tier pertama (misal: 0.22)
      } else if (typeof item.price === 'number' || typeof item.price === 'string') {
        price = item.price;
      }

      if (!sku || price === null || price === undefined) {
        skippedCount++;
        continue;
      }

      // Cari SKU di Shopify via GraphQL Admin API
      const graphqlQuery = {
        query: `
          query {
            productVariants(first: 1, query: "sku:${sku}") {
              edges {
                node {
                  id
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

      if (!shopifySearch.ok) continue;

      const shopifyData = await shopifySearch.json();
      const variants = shopifyData.data?.productVariants?.edges || [];

      if (variants.length > 0) {
        const variantNode = variants[0].node;
        const variantId = variantNode.id;
        const newPriceStr = price.toString();

        // Update jika harga di Shopify berbeda dengan harga Trends NZ
        if (variantNode.price !== newPriceStr) {
          const updateMutation = {
            query: `
              mutation productVariantUpdate($input: ProductVariantInput!) {
                productVariantUpdate(input: $input) {
                  productVariant {
                    id
                    price
                  }
                }
              }
            `,
            variables: {
              input: {
                id: variantId,
                price: newPriceStr
              }
            }
          };

          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updateMutation)
          });

          updatedCount++;
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: `Proses Selesai. Berhasil memperbarui ${updatedCount} produk.`,
      skipped: skippedCount
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}