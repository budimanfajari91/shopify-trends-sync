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

// Mengambil harga modal dari tier QUANTITY PALING RENDAH
function getLowestQuantityTier(item) {
  let tiers = null;
  if (item.pricing && Array.isArray(item.pricing.prices) && item.pricing.prices.length > 0) {
    tiers = item.pricing.prices;
  } else if (Array.isArray(item.prices) && item.prices.length > 0) {
    tiers = item.prices;
  }

  if (tiers) {
    const validTiers = tiers
      .map((t) => {
        const rawPrice = t.price ?? t.unit_price;
        const price = rawPrice !== undefined && rawPrice !== null ? parseFloat(rawPrice) : NaN;
        const rawQty = t.quantity ?? t.qty ?? t.min_qty ?? t.min_quantity;
        const qty = rawQty !== undefined && rawQty !== null ? parseFloat(rawQty) : NaN;
        return { qty, price };
      })
      .filter((t) => !isNaN(t.price) && t.price > 0);

    if (validTiers.length > 0) {
      // Urutkan dari quantity paling kecil; jika field qty tidak tersedia, ambil harga tertinggi (tier terendah)
      validTiers.sort((a, b) => {
        const aHasQty = !isNaN(a.qty) && a.qty > 0;
        const bHasQty = !isNaN(b.qty) && b.qty > 0;
        if (aHasQty && bHasQty) return a.qty - b.qty;
        if (aHasQty) return -1;
        if (bHasQty) return 1;
        return b.price - a.price;
      });

      return {
        qty: !isNaN(validTiers[0].qty) ? validTiers[0].qty : null,
        basePrice: validTiers[0].price
      };
    }
  }

  if (item.price !== undefined && item.price !== null && !isNaN(parseFloat(item.price)) && parseFloat(item.price) > 0) {
    return { qty: 1, basePrice: parseFloat(item.price) };
  }

  return null;
}

// Helper mengambil 1 halaman Trends.nz
async function fetchTrendsPage(pageNum, pageSize, authHeader, cachedParam = null) {
  const headers = {
    'Authorization': authHeader,
    'Accept': 'application/json'
  };

  const extract = (data) => ({
    items: Array.isArray(data) ? data : (data.products || data.data || []),
    totalItems: data.total_items || 0,
    pageCount: data.page_count || 1,
    pageCurrent: data.page_current || pageNum
  });

  if (pageNum === 1) {
    const res = await fetch(
      `https://au.api.trends.nz/api/v1/products.json?page_size=${pageSize}`,
      { headers }
    );
    if (!res.ok) throw new Error(`Trends API HTTP ${res.status}`);
    const data = await res.json();
    return { ...extract(data), usedParam: cachedParam };
  }

  const candidates = cachedParam
    ? [cachedParam]
    : ['page_no', 'page_current', 'page', 'p'];

  for (const param of candidates) {
    const res = await fetch(
      `https://au.api.trends.nz/api/v1/products.json?page_size=${pageSize}&${param}=${pageNum}`,
      { headers }
    );
    if (!res.ok) continue;
    const data = await res.json();
    const parsed = extract(data);

    if (parsed.pageCurrent === pageNum || candidates.length === 1) {
      return { ...parsed, usedParam: param };
    }
  }

  throw new Error(`Parameter paginasi Trends.nz untuk halaman ${pageNum} tidak dikenali.`);
}

// Helper mencari SKU di Shopify secara batch (50 SKU per query GraphQL)
async function lookupShopifyVariantsBatch(skus, storeDomain, token) {
  const skuMap = new Map();
  if (skus.length === 0) return skuMap;

  const CHUNK_SIZE = 50;
  const chunks = [];
  for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
    chunks.push(skus.slice(i, i + CHUNK_SIZE));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      const orQuery = chunk
        .map((s) => `sku:"${s.replace(/["\\]/g, '')}"`)
        .join(' OR ');

      const graphqlQuery = {
        query: `
          query findVariantsBatch($query: String!) {
            productVariants(first: 250, query: $query) {
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
        variables: { query: orQuery }
      };

      const res = await fetch(`https://${storeDomain}/admin/api/2026-01/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(graphqlQuery)
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Shopify Search HTTP ${res.status}: ${txt.slice(0, 150)}`);
      }

      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        throw new Error(`Shopify GraphQL Error: ${json.errors[0].message}`);
      }

      const edges = json.data?.productVariants?.edges || [];
      for (const edge of edges) {
        const node = edge.node;
        const cleanSku = (node.sku || '').trim().toLowerCase();
        if (!cleanSku) continue;

        if (!skuMap.has(cleanSku)) {
          skuMap.set(cleanSku, []);
        }
        skuMap.get(cleanSku).push({
          variantId: node.id,
          productId: node.product?.id,
          currentPrice: parseFloat(node.price).toFixed(2)
        });
      }
    })
  );

  return skuMap;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 7000;

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

    const startPage = Math.max(1, parseInt(req.query.page || '1', 10));
    const isAutoBrowser = req.query.auto === '1';
    const isCron = req.query.cron === '1';
    const PAGE_SIZE = 250;
    const MARKUP_MULTIPLIER = 1.50; // Markup 50% pada quantity paling rendah

    let currentPage = startPage;
    let totalPages = startPage;
    let totalCatalogItems = 0;
    let detectedPageParam = req.query.p_param || null;

    let totalTrendsChecked = 0;
    let totalVariantsUpdated = 0;
    let totalVariantsUnchanged = 0;
    let totalSkippedNoPrice = 0;
    let totalNotInShopify = 0;
    const updatedDetails = [];
    const updateErrors = [];

    while (currentPage <= totalPages) {
      if (currentPage > startPage && Date.now() - startTime > TIME_BUDGET_MS) {
        break;
      }

      const pageData = await fetchTrendsPage(
        currentPage,
        PAGE_SIZE,
        authHeader,
        detectedPageParam
      );

      if (pageData.usedParam) detectedPageParam = pageData.usedParam;
      totalPages = pageData.pageCount;
      totalCatalogItems = pageData.totalItems;

      const items = pageData.items;
      if (!items || items.length === 0) break;

      totalTrendsChecked += items.length;

      const validProducts = [];
      const uniqueSkus = new Set();

      for (const item of items) {
        const sku = (item.code || item.sku || item.item_code || '').toString().trim();
        const lowestTier = getLowestQuantityTier(item);

        if (!sku || !lowestTier) {
          totalSkippedNoPrice++;
          continue;
        }

        const skuLower = sku.toLowerCase();
        if (uniqueSkus.has(skuLower)) continue;
        uniqueSkus.add(skuLower);

        validProducts.push({
          sku,
          skuLower,
          minQty: lowestTier.qty,
          basePrice: lowestTier.basePrice,
          newPriceStr: (lowestTier.basePrice * MARKUP_MULTIPLIER).toFixed(2)
        });
      }

      const shopifySkuMap = await lookupShopifyVariantsBatch(
        validProducts.map((p) => p.sku),
        SHOPIFY_STORE,
        SHOPIFY_TOKEN
      );

      const updatesByProduct = {};
      for (const prod of validProducts) {
        const matches = shopifySkuMap.get(prod.skuLower);
        if (!matches || matches.length === 0) {
          totalNotInShopify++;
          continue;
        }

        for (const variant of matches) {
          if (variant.currentPrice !== prod.newPriceStr) {
            if (!updatesByProduct[variant.productId]) {
              updatesByProduct[variant.productId] = [];
            }
            updatesByProduct[variant.productId].push({
              variantId: variant.variantId,
              sku: prod.sku,
              minQty: prod.minQty,
              basePrice: prod.basePrice,
              currentShopifyPrice: variant.currentPrice,
              newPriceStr: prod.newPriceStr
            });
          } else {
            totalVariantsUnchanged++;
          }
        }
      }

      const productIds = Object.keys(updatesByProduct);
      for (let i = 0; i < productIds.length; i += 5) {
        const batchProductIds = productIds.slice(i, i + 5);

        await Promise.all(
          batchProductIds.map(async (productId) => {
            const itemsToUpdate = updatesByProduct[productId];
            const bulkMutation = {
              query: `
                mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    productVariants { id price }
                    userErrors { field message }
                  }
                }
              `,
              variables: {
                productId,
                variants: itemsToUpdate.map((v) => ({
                  id: v.variantId,
                  price: v.newPriceStr
                }))
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
                totalVariantsUpdated++;
                if (updatedDetails.length < 50) {
                  updatedDetails.push({
                    sku: item.sku,
                    qty_terendah: item.minQty,
                    modal_trends: item.basePrice,
                    harga_lama: item.currentShopifyPrice,
                    harga_baru: item.newPriceStr
                  });
                }
              });
            }
          })
        );
      }

      currentPage++;
    }

    const lastProcessedPage = currentPage - 1;
    const isFinished = currentPage > totalPages;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const paramQuery = detectedPageParam ? `&p_param=${detectedPageParam}` : '';
    const nextUrl = `${protocol}://${host}/api/sync?page=${currentPage}${paramQuery}`;

    if (isCron && !isFinished && host) {
      const nextCronUrl = `${nextUrl}&cron=1`;
      await Promise.race([
        fetch(nextCronUrl).catch(() => {}),
        sleep(250)
      ]);
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const summaryPayload = {
      success: true,
      selesai_semua_halaman: isFinished,
      waktu_eksekusi_detik: parseFloat(durationSec),
      halaman_diproses: `${startPage} - ${lastProcessedPage} dari ${totalPages}`,
      total_katalog_trends: totalCatalogItems,
      produk_trends_dicek_sesi_ini: totalTrendsChecked,
      total_varian_diubah: totalVariantsUpdated,
      varian_harga_sudah_sesuai: totalVariantsUnchanged,
      produk_tanpa_harga_dilewati: totalSkippedNoPrice,
      sku_tidak_ada_di_shopify: totalNotInShopify,
      halaman_berikutnya: isFinished ? null : currentPage,
      url_berikutnya: isFinished ? null : nextUrl,
      error_saat_update: updateErrors,
      contoh_update: updatedDetails
    };

    if (isAutoBrowser) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8" />
          <title>Sinkronisasi Shopify x Trends.nz</title>
          ${!isFinished ? `<meta http-equiv="refresh" content="1;url=${nextUrl}&auto=1" />` : ''}
          <style>
            body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
            .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-weight: 600; background: ${isFinished ? '#dcfce7' : '#fef9c3'}; color: ${isFinished ? '#166534' : '#854d0e'}; }
            pre { background: #f4f4f5; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
          </style>
        </head>
        <body>
          <h2>Sinkronisasi Harga Trends.nz → Shopify (Qty Terendah + Markup 50%)</h2>
          <p><span class="badge">${isFinished ? 'SELESAI 100%' : `MEMPROSES HALAMAN ${currentPage} DARI ${totalPages}...`}</span></p>
          <pre>${JSON.stringify(summaryPayload, null, 2)}</pre>
        </body>
        </html>
      `);
    }

    return res.status(200).json(summaryPayload);

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}