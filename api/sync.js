import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    // Masukkan prefiks Bearer secara otomatis jika belum ada
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

    // Tangani format data list dari Trends NZ
    const productList = Array.isArray(trendsData) 
      ? trendsData 
      : (trendsData.products || trendsData.data || []);

    // 2. Loop & update harga ke Shopify
    for (const item of productList) {
      // Pembacaan fleksibel untuk nama field SKU & Price dari Trends NZ
      const sku = item.sku || item.code || item.product_code;
      const rawPrice = item.price || item.wholesale_price || (item.pricing && item.pricing.wholesale);

      if (!sku || !rawPrice) continue;

      const price = rawPrice.toString();

      // Cari Variant ID di Shopify via GraphQL API (lebih akurat untuk SKU)
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
        const variantId = variantNode.id; // Format GraphQL ID: gid://shopify/ProductVariant/xxxx

        // Update harga jika beda
        if (variantNode.price !== price) {
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
                price: price
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
      message: `Berhasil sinkronisasi ${updatedCount} produk.`
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}