import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    let SHOPIFY_STORE = (process.env.SHOPIFY_STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    const authHeader = TRENDS_TOKEN?.startsWith('Bearer') 
      ? TRENDS_TOKEN 
      : `Bearer ${TRENDS_TOKEN}`;

    // 1. Ambil data produk dari Trends NZ
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

    let trulyUpdatedList = [];
    let unchangedCount = 0;
    let notFoundCount = 0;

    // Koefisien Markup: 1 + 0.645 = 1.645 (Markup 64.5%)
    const MARKUP_MULTIPLIER = 1.645;

    for (const item of productList) {
      const sku = item.code || item.sku;
      let basePrice = null;

      // Ambil harga dari tier quantity paling sedikit (indeks pertama / prices[0])
      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        basePrice = item.pricing.prices[0].price;
      } else if (typeof item.price === 'number' || typeof item.price === 'string') {
        basePrice = item.price;
      }

      if (!sku || basePrice === null || basePrice === undefined) continue;

      // Hitung harga akhir dengan markup
      const calculatedPrice = parseFloat(basePrice) * MARKUP_MULTIPLIER;
      const newPriceStr = calculatedPrice.toFixed(2);

      // 2. Cari produk di Shopify berdasarkan SKU
      const graphqlQuery = {
        query: `
          query {
            productVariants(first: 1, query: "sku:${sku}") {
              edges {
                node {
                  id
                  price
                  product {
                    id
                  }
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
        const productId = variantNode.product?.id;
        const currentShopifyPrice = parseFloat(variantNode.price).toFixed(2);

        // Hanya proses jika ada perbedaan harga
        if (currentShopifyPrice !== newPriceStr) {
          
          // Step A: Update harga utama pada produk
          const updatePriceMutation = {
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

          const updateRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePriceMutation)
          });

          // Step B: Update tanggal "Updated" pada induk informasi produk di Shopify Admin
          if (productId) {
            const touchProductMutation = {
              query: `
                mutation productUpdate($input: ProductInput!) {
                  productUpdate(input: $input) {
                    product {
                      id
                    }
                  }
                }
              `,
              variables: {
                input: { id: productId }
              }
            };

            await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
              method: 'POST',
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(touchProductMutation)
            });
          }

          if (updateRes.ok) {
            trulyUpdatedList.push({
              sku: sku,
              modal_trends_lowest_qty: basePrice,
              harga_lama: currentShopifyPrice,
              harga_baru_dengan_markup: newPriceStr
            });
          }
        } else {
          unchangedCount++;
        }
      } else {
        notFoundCount++;
      }
    }

    return res.status(200).json({
      success: true,
      total_produk_diubah: trulyUpdatedList.length,
      produk_harga_sudah_sesuai: unchangedCount,
      sku_tidak_ditemukan: notFoundCount,
      detail_update: trulyUpdatedList
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}