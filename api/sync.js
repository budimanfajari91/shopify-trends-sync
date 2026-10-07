import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    let SHOPIFY_STORE = (process.env.SHOPIFY_STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    const page = req.query.page || 1;

    const authHeader = TRENDS_TOKEN?.startsWith('Bearer') 
      ? TRENDS_TOKEN 
      : `Bearer ${TRENDS_TOKEN}`;

    // 1. Ambil data Trends.nz per halaman
    const trendsRes = await fetch(`https://au.api.trends.nz/api/v1/products.json?page=${page}`, {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });

    if (!trendsRes.ok) {
      return res.status(trendsRes.status).json({ success: false, message: `Gagal mengambil data Trends NZ halaman ${page}` });
    }

    const trendsData = await trendsRes.json();
    const productList = Array.isArray(trendsData) 
      ? trendsData 
      : (trendsData.products || trendsData.data || []);

    if (productList.length === 0) {
      return res.status(200).json({ success: true, message: `Tidak ada data produk di halaman ${page}` });
    }

    const MARKUP_MULTIPLIER = 1.645; // Markup 64.5%

    // 2. Tahap Pencarian: Cari varian di Shopify & kumpulkan perubahan berdasarkan productId
    const updatesByProduct = {}; 
    let unchangedCount = 0;
    let notFoundCount = 0;
    let skippedCount = 0;

    const searchTasks = productList.map(async (item) => {
      const sku = item.code || item.sku || item.item_code;
      let basePrice = null;

      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        basePrice = item.pricing.prices[0].price ?? item.pricing.prices[0].unit_price;
      } else if (Array.isArray(item.prices) && item.prices.length > 0) {
        basePrice = item.prices[0].price ?? item.prices[0].unit_price;
      } else if (item.price !== undefined && item.price !== null) {
        basePrice = item.price;
      }

      if (!sku || basePrice === null || basePrice === undefined) {
        return { status: 'skipped' };
      }

      const calculatedPrice = parseFloat(basePrice) * MARKUP_MULTIPLIER;
      const newPriceStr = calculatedPrice.toFixed(2);

      const graphqlQuery = {
        query: `
          query {
            productVariants(first: 1, query: "sku:${sku}") {
              edges {
                node {
                  id
                  price
                  product { id }
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

      if (!shopifySearch.ok) return { status: 'error' };

      const shopifyData = await shopifySearch.json();
      const variants = shopifyData.data?.productVariants?.edges || [];

      if (variants.length > 0) {
        const variantNode = variants[0].node;
        const variantId = variantNode.id;
        const productId = variantNode.product?.id;
        const currentShopifyPrice = parseFloat(variantNode.price).toFixed(2);

        if (currentShopifyPrice !== newPriceStr) {
          return {
            status: 'needs_update',
            productId,
            variantId,
            sku,
            basePrice,
            currentShopifyPrice,
            newPriceStr
          };
        }
        return { status: 'unchanged' };
      }
      return { status: 'not_found' };
    });

    const searchResults = await Promise.all(searchTasks);

    // Grouping item yang butuh diupdate berdasarkan productId
    searchResults.forEach((res) => {
      if (res && res.status === 'needs_update') {
        if (!updatesByProduct[res.productId]) {
          updatesByProduct[res.productId] = [];
        }
        updatesByProduct[res.productId].push(res);
      } else if (res && res.status === 'unchanged') {
        unchangedCount++;
      } else if (res && res.status === 'not_found') {
        notFoundCount++;
      } else if (res && res.status === 'skipped') {
        skippedCount++;
      }
    });

    // 3. Tahap Update: Jalankan productVariantsBulkUpdate per produk
    const bulkUpdateTasks = Object.keys(updatesByProduct).map(async (productId) => {
      const itemsToUpdate = updatesByProduct[productId];

      const variantsInput = itemsToUpdate.map((item) => ({
        id: item.variantId,
        price: item.newPriceStr
      }));

      const bulkMutation = {
        query: `
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
                price
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          productId: productId,
          variants: variantsInput
        }
      };

      const updateRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bulkMutation)
      });

      if (updateRes.ok) {
        return itemsToUpdate.map((item) => ({
          sku: item.sku,
          modal_trends: item.basePrice,
          harga_lama: item.currentShopifyPrice,
          harga_baru: item.newPriceStr
        }));
      }
      return [];
    });

    const bulkResults = await Promise.all(bulkUpdateTasks);
    const trulyUpdatedList = bulkResults.flat();

    return res.status(200).json({
      success: true,
      metode: 'productVariantsBulkUpdate',
      halaman_saat_ini: parseInt(page),
      total_diproses: productList.length,
      total_produk_diubah: trulyUpdatedList.length,
      produk_harga_sudah_sesuai: unchangedCount,
      sku_tidak_ditemukan: notFoundCount,
      produk_dilewati: skippedCount,
      detail_update: trulyUpdatedList
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}