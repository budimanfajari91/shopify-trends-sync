import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    let SHOPIFY_STORE = (process.env.SHOPIFY_STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    const authHeader = TRENDS_TOKEN?.startsWith('Bearer')
      ? TRENDS_TOKEN
      : `Bearer ${TRENDS_TOKEN}`;

    // 1. Tarik seluruh produk dari Trends NZ (Melintasi semua halaman)
    let productList = [];
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      const trendsRes = await fetch(`https://au.api.trends.nz/api/v1/products.json?page=${page}`, {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json'
        }
      });

      if (!trendsRes.ok) break;

      const trendsData = await trendsRes.json();
      const currentBatch = Array.isArray(trendsData)
        ? trendsData
        : (trendsData.products || trendsData.data || []);

      if (currentBatch.length === 0) {
        hasMorePages = false;
      } else {
        productList = productList.concat(currentBatch);
        page++;
        // Batasi maksimal 10 halaman (1000 produk) untuk mencegah Vercel execution timeout
        if (page > 10) hasMorePages = false;
      }
    }

    if (productList.length === 0) {
      return res.status(200).json({ success: false, message: 'Tidak ada data produk yang ditemukan dari Trends NZ.' });
    }

    let trulyUpdatedList = [];
    let unchangedCount = 0;
    let notFoundCount = 0;

    // Koefisien Markup: 1 + 0.645 = 1.645 (Markup 64.5%)
    const MARKUP_MULTIPLIER = 1.645;

    // 2. Loop SELURUH produk yang berhasil ditarik
    for (const item of productList) {
      const sku = item.code || item.sku;
      let basePrice = null;

      // Ambil harga kuantitas paling sedikit (prices[0])
      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        basePrice = item.pricing.prices[0].price;
      } else if (typeof item.price === 'number' || typeof item.price === 'string') {
        basePrice = item.price;
      }

      if (!sku || basePrice === null || basePrice === undefined) continue;

      const calculatedPrice = parseFloat(basePrice) * MARKUP_MULTIPLIER;
      const newPriceStr = calculatedPrice.toFixed(2);

      // Cari SKU di Shopify via GraphQL
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

        if (currentShopifyPrice !== newPriceStr) {

          // Update harga pada varian utama
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

          // Touch induk produk agar status "Updated" di Shopify Admin menjadi "Just now"
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
      total_produk_trends_ditemukan: productList.length,
      total_produk_diubah: trulyUpdatedList.length,
      produk_harga_sudah_sesuai: unchangedCount,
      sku_tidak_ditemukan_di_shopify: notFoundCount,
      detail_update: trulyUpdatedList
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}