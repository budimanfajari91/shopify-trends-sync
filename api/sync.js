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

    // 1. Ambil data dari Trends NZ per halaman
    const trendsRes = await fetch(`https://au.api.trends.nz/api/v1/products.json?page=${page}&per_page=250`, {
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

    // 2. Pemrosesan paralel dengan pemetaan struktur SKU/Harga fleksibel
    const processTasks = productList.map(async (item) => {
      // Ambil SKU (Cek code, sku, atau item_code)
      const sku = item.code || item.sku || item.item_code;
      
      let basePrice = null;

      // Cek struktur pricing.prices
      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        basePrice = item.pricing.prices[0].price ?? item.pricing.prices[0].unit_price;
      } else if (Array.isArray(item.prices) && item.prices.length > 0) {
        basePrice = item.prices[0].price ?? item.prices[0].unit_price;
      } else if (item.price !== undefined && item.price !== null) {
        basePrice = item.price;
      }

      // Jika SKU atau Harga modal tidak valid, lewati
      if (!sku || basePrice === null || basePrice === undefined) {
        return { status: 'skipped' };
      }

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
          const updatePriceMutation = {
            query: `
              mutation productVariantUpdate($input: ProductVariantInput!) {
                productVariantUpdate(input: $input) {
                  productVariant { id price }
                }
              }
            `,
            variables: { input: { id: variantId, price: newPriceStr } }
          };

          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePriceMutation)
          });

          if (productId) {
            const touchProductMutation = {
              query: `
                mutation productUpdate($input: ProductInput!) {
                  productUpdate(input: $input) { product { id } }
                }
              `,
              variables: { input: { id: productId } }
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

          return {
            status: 'updated',
            sku,
            modal_trends: basePrice,
            harga_lama: currentShopifyPrice,
            harga_baru: newPriceStr
          };
        }
        return { status: 'unchanged', sku };
      }
      return { status: 'not_found', sku };
    });

    const results = await Promise.all(processTasks);

    const trulyUpdated = results.filter(r => r && r.status === 'updated');
    const unchangedCount = results.filter(r => r && r.status === 'unchanged').length;
    const notFoundCount = results.filter(r => r && r.status === 'not_found').length;
    const skippedCount = results.filter(r => r && r.status === 'skipped').length;

    return res.status(200).json({
      success: true,
      halaman_saat_ini: parseInt(page),
      total_diproses: productList.length,
      total_produk_diubah: trulyUpdated.length,
      produk_harga_sudah_sesuai: unchangedCount,
      sku_tidak_ditemukan: notFoundCount,
      produk_dilewati: skippedCount,
      detail_update: trulyUpdated
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}