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

// 1. Tarik seluruh katalog Trends.nz (2.794 produk)
async function fetchAllTrendsProducts(authHeader) {
  const headers = {
    'Authorization': authHeader,
    'Accept': 'application/json'
  };

  // Minta page_size=3000 agar seluruh 2.794 produk langsung ditarik sekaligus
  const firstRes = await fetch('https://au.api.trends.nz/api/v1/products.json?page_size=3000', { headers });
  if (!firstRes.ok) {
    throw new Error(`Gagal mengambil data Trends.nz (HTTP ${firstRes.status})`);
  }

  const firstData = await firstRes.json();
  const firstItems = Array.isArray(firstData)
    ? firstData
    : (firstData.products || firstData.data || []);

  const totalItems = firstData.total_items || firstItems.length;
  const pageCount = firstData.page_count || 1;

  // Jika seluruh 2.794 produk sudah terkirim dalam 1 request, langsung kembalikan
  if (firstItems.length >= totalItems || pageCount <= 1) {
    return firstItems;
  }

  // Fallback jika server membatasi maksimal page_size: deteksi parameter halaman yang valid
  const allItems = [...firstItems];
  const pageSize = firstItems.length;
  const firstCode = firstItems[0]?.code;

  let pageParam = 'page_no';
  const testRes = await fetch(
    `https://au.api.trends.nz/api/v1/products.json?page_size=${pageSize}&page_no=2`,
    { headers }
  );
  const testData = await testRes.json();
  const testItems = Array.isArray(testData) ? testData : (testData.products || testData.data || []);

  if (testItems.length > 0 && testItems[0]?.code !== firstCode) {
    allItems.push(...testItems);
  } else {
    pageParam = 'page_current';
    const testRes2 = await fetch(
      `https://au.api.trends.nz/api/v1/products.json?page_size=${pageSize}&page_current=2`,
      { headers }
    );
    const testData2 = await testRes2.json();
    const testItems2 = Array.isArray(testData2) ? testData2 : (testData2.products || testData2.data || []);
    allItems.push(...testItems2);
  }

  // Ambil sisa halaman 3 sampai pageCount secara paralel (5 halaman per batch)
  const remainingPages = [];
  for (let p = 3; p <= pageCount; p++) {
    remainingPages.push(p);
  }

  for (let i = 0; i < remainingPages.length; i += 5) {
    const batch = remainingPages.slice(i, i + 5);
    const batchData = await Promise.all(
      batch.map(async (p) => {
        const r = await fetch(
          `https://au.api.trends.nz/api/v1/products.json?page_size=${pageSize}&${pageParam}=${p}`,
          { headers }
        );
        const j = await r.json();
        return Array.isArray(j) ? j : (j.products || j.data || []);
      })
    );
    batchData.forEach((items) => allItems.push(...items));
  }

  return allItems;
}

// 2. Tarik seluruh varian di Shopify (250 varian per request)
async function fetchAllShopifyVariants(storeDomain, token) {
  const skuMap = new Map();
  let hasNextPage = true;
  let cursor = null;
  let totalVariantsScanned = 0;

  while (hasNextPage) {
    const query = `
      query getAllVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              sku
              price
              product {
                id
              }
            }
          }
        }
      }
    `;

    const res = await fetch(`https://${storeDomain}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables: { cursor } })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gagal mengambil varian Shopify (HTTP ${res.status}): ${errText.slice(0, 200)}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL Error Shopify: ${json.errors[0].message}`);
    }

    const connection = json.data?.productVariants;
    const edges = connection?.edges || [];

    for (const edge of edges) {
      totalVariantsScanned++;
      const node = edge.node;
      const cleanSku = (node.sku || '').trim();
      if (cleanSku) {
        const key = cleanSku.toLowerCase();
        if (!skuMap.has(key)) {
          skuMap.set(key, []);
        }
        // Simpan dalam array agar semua varian warna/ukuran dengan SKU sama ikut ter-update
        skuMap.get(key).push({
          variantId: node.id,
          productId: node.product?.id,
          currentPrice: parseFloat(node.price).toFixed(2)
        });
      }
    }

    hasNextPage = connection?.pageInfo?.hasNextPage || false;
    cursor = connection?.pageInfo?.endCursor || null;

    const availableCost = json.extensions?.cost?.throttleStatus?.currentlyAvailable;
    if (hasNextPage && availableCost !== undefined && availableCost < 550) {
      await sleep(500);
    }
  }

  return { skuMap, totalVariantsScanned };
}

export default async function handler(req, res) {
  const startTime = Date.now();

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

    const MARKUP_MULTIPLIER = 1.645; // Markup 64.5%

    // Jalankan penarikan data Trends.nz dan Shopify secara paralel
    const [allTrendsProducts, { skuMap: shopifySkuMap, totalVariantsScanned }] = await Promise.all([
      fetchAllTrendsProducts(authHeader),
      fetchAllShopifyVariants(SHOPIFY_STORE, SHOPIFY_TOKEN)
    ]);

    // 3. Cocokkan seluruh 2.794 produk Trends.nz dengan seluruh varian Shopify
    const updatesByProduct = {};
    const processedSkus = new Set();
    let unchangedVariantsCount = 0;
    let skippedNoPriceCount = 0;
    let notInShopifyCount = 0;

    for (const item of allTrendsProducts) {
      const sku = (item.code || item.sku || item.item_code || '').toString().trim();
      if (!sku) {
        skippedNoPriceCount++;
        continue;
      }

      const skuKey = sku.toLowerCase();
      if (processedSkus.has(skuKey)) continue;
      processedSkus.add(skuKey);

      const matchingVariants = shopifySkuMap.get(skuKey);
      if (!matchingVariants || matchingVariants.length === 0) {
        notInShopifyCount++;
        continue;
      }

      let basePrice = null;
      if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
        basePrice = item.pricing.prices[0].price ?? item.pricing.prices[0].unit_price;
      } else if (Array.isArray(item.prices) && item.prices.length > 0) {
        basePrice = item.prices[0].price ?? item.prices[0].unit_price;
      } else if (item.price !== undefined && item.price !== null) {
        basePrice = item.price;
      }

      if (basePrice === null || basePrice === undefined || isNaN(parseFloat(basePrice))) {
        skippedNoPriceCount++;
        continue;
      }

      const newPriceStr = (parseFloat(basePrice) * MARKUP_MULTIPLIER).toFixed(2);

      for (const variant of matchingVariants) {
        if (variant.currentPrice !== newPriceStr) {
          if (!updatesByProduct[variant.productId]) {
            updatesByProduct[variant.productId] = [];
          }
          updatesByProduct[variant.productId].push({
            variantId: variant.variantId,
            sku,
            basePrice,
            currentShopifyPrice: variant.currentPrice,
            newPriceStr
          });
        } else {
          unchangedVariantsCount++;
        }
      }
    }

    // 4. Bulk update ke Shopify HANYA untuk varian yang harganya berubah
    const trulyUpdatedList = [];
    const updateErrors = [];
    const productIdsToUpdate = Object.keys(updatesByProduct);

    for (const productId of productIdsToUpdate) {
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

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

    return res.status(200).json({
      success: true,
      waktu_eksekusi_detik: parseFloat(durationSec),
      total_katalog_trends_terbaca: allTrendsProducts.length,
      total_varian_shopify_terbaca: totalVariantsScanned,
      total_varian_diubah: trulyUpdatedList.length,
      varian_harga_sudah_sesuai: unchangedVariantsCount,
      produk_trends_tanpa_harga_dilewati: skippedNoPriceCount,
      produk_trends_tidak_ada_di_shopify: notInShopifyCount,
      error_saat_update: updateErrors,
      detail_update_maks_100: trulyUpdatedList.slice(0, 100)
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}