import fetch from 'node-fetch';

function normalizeShopifyDomain(rawUrl = '') {
  let clean = rawUrl.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const adminMatch = clean.match(/^admin\.shopify\.com\/store\/([^/]+)/);
  if (adminMatch) {
    return `${adminMatch[1]}.myshopify.com`;
  }
  return clean;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    const SHOPIFY_STORE = normalizeShopifyDomain(process.env.SHOPIFY_STORE_URL);
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

    if (!TRENDS_TOKEN || !SHOPIFY_STORE || !SHOPIFY_TOKEN) {
      return res.status(400).json({
        success: false,
        message: 'Environment variables (TRENDS_API_TOKEN, SHOPIFY_STORE_URL, SHOPIFY_ADMIN_TOKEN) belum lengkap.'
      });
    }

    const authHeader = TRENDS_TOKEN.startsWith('Bearer')
      ? TRENDS_TOKEN
      : `Bearer ${TRENDS_TOKEN}`;

    // MODE INSPEKSI: Buka /api/sync?inspect=1 untuk mengecek struktur & parameter paginasi Trends.nz
    if (req.query.inspect === '1') {
      const headers = { 'Authorization': authHeader, 'Accept': 'application/json' };
      const [resDefault, resOffset, resStart, resPageSize] = await Promise.all([
        fetch('https://au.api.trends.nz/api/v1/products.json', { headers }),
        fetch('https://au.api.trends.nz/api/v1/products.json?offset=100', { headers }),
        fetch('https://au.api.trends.nz/api/v1/products.json?start=100', { headers }),
        fetch('https://au.api.trends.nz/api/v1/products.json?page_size=250', { headers })
      ]);

      const dataDefault = await resDefault.json();
      const dataOffset = await resOffset.json();
      const dataStart = await resStart.json();
      const dataPageSize = await resPageSize.json();

      const extractList = (d) => Array.isArray(d) ? d : (d.products || d.data || []);
      const metadata = {};
      if (!Array.isArray(dataDefault) && typeof dataDefault === 'object' && dataDefault !== null) {
        for (const [k, v] of Object.entries(dataDefault)) {
          if (!Array.isArray(v)) metadata[k] = v;
        }
      }

      return res.status(200).json({
        tipe_root_json: Array.isArray(dataDefault) ? 'array' : 'object',
        metadata_root_trends: metadata,
        jumlah_item_default: extractList(dataDefault).length,
        kode_pertama_default: extractList(dataDefault)[0]?.code ?? null,
        kode_pertama_dengan_offset_100: extractList(dataOffset)[0]?.code ?? null,
        kode_pertama_dengan_start_100: extractList(dataStart)[0]?.code ?? null,
        jumlah_item_dengan_page_size_250: extractList(dataPageSize).length
      });
    }

    const page = parseInt(req.query.page || '1', 10);

    // 1. Ambil data Trends.nz per halaman
    const trendsRes = await fetch(`https://au.api.trends.nz/api/v1/products.json?page=${page}`, {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });

    if (!trendsRes.ok) {
      const errText = await trendsRes.text();
      return res.status(trendsRes.status).json({
        success: false,
        message: `Gagal mengambil data Trends NZ halaman ${page}`,
        detail: errText.slice(0, 300)
      });
    }

    const trendsData = await trendsRes.json();
    const productList = Array.isArray(trendsData)
      ? trendsData
      : (trendsData.products || trendsData.data || []);

    if (productList.length === 0) {
      return res.status(200).json({
        success: true,
        message: `Tidak ada data produk di halaman ${page}`
      });
    }

    const MARKUP_MULTIPLIER = 1.645;
    const updatesByProduct = {};
    let unchangedCount = 0;
    let notFoundCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const sampleErrors = [];
    const sampleSkipped = [];

    const processItem = async (item) => {
      const sku = (item.code || item.sku || item.item_code || '').toString().trim();
      let basePrice = null;

      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        basePrice = item.pricing.prices[0].price ?? item.pricing.prices[0].unit_price;
      } else if (Array.isArray(item.prices) && item.prices.length > 0) {
        basePrice = item.prices[0].price ?? item.prices[0].unit_price;
      } else if (item.price !== undefined && item.price !== null) {
        basePrice = item.price;
      }

      if (!sku || basePrice === null || basePrice === undefined || isNaN(parseFloat(basePrice))) {
        return {
          status: 'skipped',
          debug: { code: item.code, name: item.name, pricing: item.pricing || item.prices || item.price }
        };
      }

      const calculatedPrice = parseFloat(basePrice) * MARKUP_MULTIPLIER;
      const newPriceStr = calculatedPrice.toFixed(2);

      const graphqlQuery = {
        query: `
          query findVariantBySku($query: String!) {
            productVariants(first: 10, query: $query) {
              edges {
                node {
                  id
                  sku
                  price
                  product { id }
                }
              }
            }
          }
        `,
        variables: {
          query: `sku:"${sku}"`
        }
      };

      const shopifySearch = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(graphqlQuery)
      });

      if (!shopifySearch.ok) {
        const text = await shopifySearch.text();
        return {
          status: 'error',
          reason: `HTTP ${shopifySearch.status} (${SHOPIFY_STORE}): ${text.slice(0, 200)}`
        };
      }

      const shopifyData = await shopifySearch.json();

      if (shopifyData.errors && shopifyData.errors.length > 0) {
        return {
          status: 'error',
          reason: `GraphQL Error: ${shopifyData.errors[0].message}`
        };
      }

      const edges = shopifyData.data?.productVariants?.edges || [];
      const exactMatch = edges.find(
        (edge) => (edge.node.sku || '').trim().toLowerCase() === sku.toLowerCase()
      );

      if (exactMatch) {
        const variantNode = exactMatch.node;
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
    };

    const BATCH_SIZE = 5;
    const searchResults = [];

    for (let i = 0; i < productList.length; i += BATCH_SIZE) {
      const batch = productList.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(processItem));
      searchResults.push(...batchResults);

      if (i + BATCH_SIZE < productList.length) {
        await sleep(250);
      }
    }

    searchResults.forEach((result) => {
      if (!result) return;

      if (result.status === 'needs_update') {
        if (!updatesByProduct[result.productId]) {
          updatesByProduct[result.productId] = [];
        }
        updatesByProduct[result.productId].push(result);
      } else if (result.status === 'unchanged') {
        unchangedCount++;
      } else if (result.status === 'not_found') {
        notFoundCount++;
      } else if (result.status === 'skipped') {
        skippedCount++;
        if (sampleSkipped.length < 3) sampleSkipped.push(result.debug);
      } else if (result.status === 'error') {
        errorCount++;
        if (sampleErrors.length < 3) sampleErrors.push(result.reason);
      }
    });

    const trulyUpdatedList = [];
    const updateErrors = [];

    for (const productId of Object.keys(updatesByProduct)) {
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
          productId,
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

      const updateData = await updateRes.json();
      const userErrors = updateData.data?.productVariantsBulkUpdate?.userErrors || [];

      if (!updateRes.ok || updateData.errors || userErrors.length > 0) {
        updateErrors.push({
          productId,
          errors: updateData.errors || userErrors
        });
      } else {
        itemsToUpdate.forEach((item) => {
          trulyUpdatedList.push({
            sku: item.sku,
            modal_trends: item.basePrice,
            harga_lama: item.currentShopifyPrice,
            harga_baru: item.newPriceStr
          });
        });
      }

      await sleep(200);
    }

    return res.status(200).json({
      success: true,
      shopify_domain_terpakai: SHOPIFY_STORE,
      halaman_saat_ini: page,
      total_diproses: productList.length,
      total_produk_diubah: trulyUpdatedList.length,
      produk_harga_sudah_sesuai: unchangedCount,
      sku_tidak_ditemukan: notFoundCount,
      produk_dilewati: skippedCount,
      total_error: errorCount,
      contoh_error: sampleErrors,
      contoh_dilewati: sampleSkipped,
      error_saat_update: updateErrors,
      detail_update: trulyUpdatedList
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}