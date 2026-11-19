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

function roundMoney(num) {
  return Math.round((num + 1e-9) * 100) / 100;
}

function normalizeTitle(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Mengambil harga modal dari QUANTITY PALING RENDAH + Branding Utama + Shipping & Handling ($15)
function calculateLowestQtyCost(item, shippingHandlingFee = 15) {
  const pricingObj = Array.isArray(item.pricing)
    ? item.pricing.find((p) => (p.type || '').toLowerCase() === 'stock') || item.pricing[0]
    : item.pricing;

  let tiers = null;
  if (pricingObj && Array.isArray(pricingObj.prices) && pricingObj.prices.length > 0) {
    tiers = pricingObj.prices;
  } else if (Array.isArray(item.prices) && item.prices.length > 0) {
    tiers = item.prices;
  }

  let minQty = null;
  let blankPrice = NaN;

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
      validTiers.sort((a, b) => {
        const aHasQty = !isNaN(a.qty) && a.qty > 0;
        const bHasQty = !isNaN(b.qty) && b.qty > 0;
        if (aHasQty && bHasQty) return a.qty - b.qty;
        if (aHasQty) return -1;
        if (bHasQty) return 1;
        return b.price - a.price;
      });

      minQty = !isNaN(validTiers[0].qty) && validTiers[0].qty > 0 ? validTiers[0].qty : 1;
      blankPrice = validTiers[0].price;
    }
  } else if (item.price !== undefined && item.price !== null && parseFloat(item.price) > 0) {
    minQty = 1;
    blankPrice = parseFloat(item.price);
  }

  if (isNaN(blankPrice) || blankPrice <= 0) {
    return null;
  }

  let brandingUnitCost = 0;
  let brandingSetupCost = 0;
  const additionalCosts = Array.isArray(pricingObj?.additional_costs)
    ? pricingObj.additional_costs
    : [];

  if (additionalCosts.length > 0) {
    const primaryCost =
      additionalCosts.find((c) => (c.type || '').toUpperCase() === 'DO') || additionalCosts[0];

    if (primaryCost) {
      let unitPrice = parseFloat(primaryCost.unit_price || 0);
      if (Array.isArray(primaryCost.prices) && primaryCost.prices.length > 0) {
        const sortedBrandingTiers = [...primaryCost.prices]
          .map((p) => ({
            qty: parseFloat(p.quantity ?? p.qty ?? 1),
            price: parseFloat(p.price ?? p.unit_price ?? 0)
          }))
          .filter((p) => !isNaN(p.price))
          .sort((a, b) => a.qty - b.qty);

        if (sortedBrandingTiers.length > 0) {
          unitPrice = sortedBrandingTiers[0].price;
        }
      }

      brandingUnitCost = isNaN(unitPrice) ? 0 : unitPrice;
      const rawSetup = parseFloat(primaryCost.setup_price ?? primaryCost.setup ?? 0);
      brandingSetupCost = isNaN(rawSetup) ? 0 : rawSetup;
    }
  }

  const setupAndShippingPerUnit = minQty > 0 ? (brandingSetupCost + shippingHandlingFee) / minQty : 0;
  const totalBaseCost = blankPrice + brandingUnitCost + setupAndShippingPerUnit;

  return {
    qty: minQty,
    blankPrice,
    brandingUnitCost,
    brandingSetupCost,
    shippingHandlingFee,
    totalBaseCost: roundMoney(totalBaseCost)
  };
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

// Helper khusus mode ?report=1: Tarik seluruh katalog Trends.nz secara paralel
async function fetchAllTrendsCatalogForReport(authHeader) {
  const first = await fetchTrendsPage(1, 250, authHeader, null);
  const allItems = [...first.items];
  const totalPages = first.pageCount || 1;

  if (totalPages <= 1) {
    return { items: allItems, totalCatalog: first.totalItems || allItems.length };
  }

  const second = await fetchTrendsPage(2, 250, authHeader, null);
  allItems.push(...second.items);
  const validParam = second.usedParam || 'page_no';

  const restPages = [];
  for (let p = 3; p <= totalPages; p++) restPages.push(p);

  for (let i = 0; i < restPages.length; i += 6) {
    const batch = restPages.slice(i, i + 6);
    const results = await Promise.all(
      batch.map((p) => fetchTrendsPage(p, 250, authHeader, validParam))
    );
    results.forEach((r) => allItems.push(...r.items));
  }

  return { items: allItems, totalCatalog: first.totalItems || allItems.length };
}

// Helper khusus mode ?report=1: Tarik seluruh varian Shopify ke Map (250 varian/request)
async function fetchAllShopifyVariantsMap(storeDomain, token) {
  const skuMap = new Map();
  const titleMap = new Map();
  let hasNextPage = true;
  let cursor = null;
  let totalVariantsScanned = 0;

  while (hasNextPage) {
    const res = await fetch(`https://${storeDomain}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `
          query getAllVariantsReport($cursor: String) {
            productVariants(first: 250, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  sku
                  price
                  product { id title }
                }
              }
            }
          }
        `,
        variables: { cursor }
      })
    });

    if (!res.ok) throw new Error(`Shopify Report HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);

    const conn = json.data?.productVariants;
    const edges = conn?.edges || [];

    for (const edge of edges) {
      totalVariantsScanned++;
      const node = edge.node;
      const cleanSku = (node.sku || '').trim();
      const entry = {
        variantId: node.id,
        productId: node.product?.id,
        currentPrice: parseFloat(node.price).toFixed(2)
      };

      if (cleanSku) {
        const key = cleanSku.toLowerCase();
        if (!skuMap.has(key)) skuMap.set(key, []);
        skuMap.get(key).push(entry);
      } else if (node.product?.title) {
        const tKey = normalizeTitle(node.product.title);
        if (tKey) {
          if (!titleMap.has(tKey)) titleMap.set(tKey, []);
          titleMap.get(tKey).push(entry);
        }
      }
    }

    hasNextPage = conn?.pageInfo?.hasNextPage || false;
    cursor = conn?.pageInfo?.endCursor || null;

    const availableCost = json.extensions?.cost?.throttleStatus?.currentlyAvailable;
    if (hasNextPage && availableCost !== undefined && availableCost < 400) {
      await sleep(400);
    }
  }

  return { skuMap, titleMap, totalVariantsScanned };
}

// Pencarian varian Shopify berdasarkan SKU (CHUNK_SIZE = 8) & opsional fallback Nama Produk
async function lookupShopifyVariantsBatch(products, storeDomain, token, enableTitleFallback = false) {
  const skuMap = new Map();
  const titleMap = new Map();
  if (products.length === 0) return { skuMap, titleMap };

  const CHUNK_SIZE = 8;
  const chunks = [];
  for (let i = 0; i < products.length; i += CHUNK_SIZE) {
    chunks.push(products.slice(i, i + CHUNK_SIZE));
  }

  const CONCURRENCY = 6;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const wave = chunks.slice(i, i + CONCURRENCY);

    await Promise.all(
      wave.map(async (chunk) => {
        const orQuery = chunk
          .map((p) => `sku:"${p.sku.replace(/["\\]/g, '')}"`)
          .join(' OR ');

        const graphqlQuery = {
          query: `
            query findVariantsBatch($query: String!) {
              productVariants(first: 40, query: $query) {
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
  }

  if (enableTitleFallback) {
    const unmatchedWithTitle = products.filter(
      (p) => !skuMap.has(p.skuLower) && p.cleanTitle.length >= 6
    );

    const titleChunks = [];
    for (let i = 0; i < unmatchedWithTitle.length; i += 6) {
      titleChunks.push(unmatchedWithTitle.slice(i, i + 6));
    }

    for (let i = 0; i < titleChunks.length; i += 5) {
      const wave = titleChunks.slice(i, i + 5);
      await Promise.all(
        wave.map(async (chunk) => {
          const titleQuery = chunk
            .map((p) => `title:"${p.rawName.replace(/["\\]/g, '')}"`)
            .join(' OR ');

          const res = await fetch(`https://${storeDomain}/admin/api/2026-01/graphql.json`, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query: `
                query findProductsByTitle($query: String!) {
                  products(first: 20, query: $query) {
                    edges {
                      node {
                        id
                        title
                        variants(first: 20) {
                          edges {
                            node {
                              id
                              sku
                              price
                            }
                          }
                        }
                      }
                    }
                  }
                }
              `,
              variables: { query: titleQuery }
            })
          });

          if (!res.ok) return;
          const json = await res.json();
          const pEdges = json.data?.products?.edges || [];

          for (const pEdge of pEdges) {
            const pNode = pEdge.node;
            const normTitle = normalizeTitle(pNode.title);
            const vEdges = pNode.variants?.edges || [];

            for (const vEdge of vEdges) {
              const vNode = vEdge.node;
              if (!vNode.sku || vNode.sku.trim() === '') {
                if (!titleMap.has(normTitle)) {
                  titleMap.set(normTitle, []);
                }
                titleMap.get(normTitle).push({
                  variantId: vNode.id,
                  productId: pNode.id,
                  currentPrice: parseFloat(vNode.price).toFixed(2)
                });
              }
            }
          }
        })
      );
    }
  }

  return { skuMap, titleMap };
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 7000;

  try {
    const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;
    const SHOPIFY_STORE = normalizeShopifyDomain(process.env.SHOPIFY_STORE_URL);
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
    const SHIPPING_FEE = parseFloat(process.env.TRENDS_SHIPPING_FEE || '15');

    if (!TRENDS_TOKEN || !SHOPIFY_STORE || !SHOPIFY_TOKEN) {
      return res.status(400).json({
        success: false,
        message: 'Environment variables (TRENDS_API_TOKEN, SHOPIFY_STORE_URL, SHOPIFY_ADMIN_TOKEN) belum lengkap.'
      });
    }

    const authHeader = TRENDS_TOKEN.startsWith('Bearer')
      ? TRENDS_TOKEN
      : `Bearer ${TRENDS_TOKEN}`;

    const MARKUP_MULTIPLIER = 1.50;
    const enableTitleFallback = req.query.match_title === '1';

    // MODE RANGKUMAN INSTAN: Buka /api/sync?report=1 untuk melihat rekap seluruh 2.794+ produk sekaligus
    if (req.query.report === '1') {
      const [{ items: allTrendsItems, totalCatalog }, { skuMap, titleMap, totalVariantsScanned }] =
        await Promise.all([
          fetchAllTrendsCatalogForReport(authHeader),
          fetchAllShopifyVariantsMap(SHOPIFY_STORE, SHOPIFY_TOKEN)
        ]);

      const seenSkus = new Set();
      let variantsAlreadyMatch = 0;
      let variantsNeedUpdate = 0;
      let skippedNoPrice = 0;
      let notFoundInShopify = 0;
      const sampleNeedUpdate = [];
      const sampleNotFound = [];

      for (const item of allTrendsItems) {
        const sku = (item.code || item.sku || item.item_code || '').toString().trim();
        const costInfo = calculateLowestQtyCost(item, SHIPPING_FEE);

        if (!sku || !costInfo) {
          skippedNoPrice++;
          continue;
        }

        const skuLower = sku.toLowerCase();
        if (seenSkus.has(skuLower)) continue;
        seenSkus.add(skuLower);

        const targetPriceStr = roundMoney(costInfo.totalBaseCost * MARKUP_MULTIPLIER).toFixed(2);
        let matches = skuMap.get(skuLower);

        if ((!matches || matches.length === 0) && enableTitleFallback) {
          matches = titleMap.get(normalizeTitle(item.name || ''));
        }

        if (!matches || matches.length === 0) {
          notFoundInShopify++;
          if (sampleNotFound.length < 25) {
            sampleNotFound.push({ sku, nama_trends: item.name || '-' });
          }
          continue;
        }

        for (const variant of matches) {
          if (variant.currentPrice === targetPriceStr) {
            variantsAlreadyMatch++;
          } else {
            variantsNeedUpdate++;
            if (sampleNeedUpdate.length < 25) {
              sampleNeedUpdate.push({
                sku,
                harga_shopify_sekarang: variant.currentPrice,
                harga_seharusnya: targetPriceStr
              });
            }
          }
        }
      }

      return res.status(200).json({
        success: true,
        mode: 'Laporan Rangkuman Keseluruhan (Read-Only)',
        waktu_eksekusi_detik: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
        total_katalog_trends: totalCatalog,
        total_produk_trends_terbaca: allTrendsItems.length,
        total_varian_shopify_terbaca: totalVariantsScanned,
        rangkuman: {
          varian_harga_sudah_sesuai: variantsAlreadyMatch,
          varian_perlu_update_harga: variantsNeedUpdate,
          produk_trends_tanpa_harga_dilewati: skippedNoPrice,
          sku_trends_tidak_ada_di_shopify: notFoundInShopify
        },
        contoh_varian_perlu_update: sampleNeedUpdate,
        contoh_sku_tidak_ada_di_shopify: sampleNotFound
      });
    }

    // MODE SINKRONISASI HALAMAN DEMI HALAMAN + AKUMULASI TOTAL
    const startPage = Math.max(1, parseInt(req.query.page || '1', 10));
    const isAutoBrowser = req.query.auto === '1';
    const isCron = req.query.cron === '1';
    const PAGE_SIZE = 150;

    // Akumulator kumulatif lintas halaman
    let accChecked = parseInt(req.query.acc_checked || '0', 10);
    let accUpdated = parseInt(req.query.acc_updated || '0', 10);
    let accUnchanged = parseInt(req.query.acc_unchanged || '0', 10);
    let accSkipped = parseInt(req.query.acc_skipped || '0', 10);
    let accNotFound = parseInt(req.query.acc_notfound || '0', 10);

    let currentPage = startPage;
    let totalPages = startPage;
    let totalCatalogItems = 0;
    let detectedPageParam = req.query.p_param || null;

    let sessionChecked = 0;
    let sessionUpdated = 0;
    let sessionUnchanged = 0;
    let sessionSkipped = 0;
    let sessionNotFound = 0;
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

      sessionChecked += items.length;

      const validProducts = [];
      const uniqueSkus = new Set();

      for (const item of items) {
        const sku = (item.code || item.sku || item.item_code || '').toString().trim();
        const costInfo = calculateLowestQtyCost(item, SHIPPING_FEE);

        if (!sku || !costInfo) {
          sessionSkipped++;
          continue;
        }

        const skuLower = sku.toLowerCase();
        if (uniqueSkus.has(skuLower)) continue;
        uniqueSkus.add(skuLower);

        const rawName = (item.name || '').toString().trim();
        const finalPriceStr = roundMoney(costInfo.totalBaseCost * MARKUP_MULTIPLIER).toFixed(2);

        validProducts.push({
          sku,
          skuLower,
          rawName,
          cleanTitle: normalizeTitle(rawName),
          minQty: costInfo.qty,
          blankPrice: costInfo.blankPrice,
          brandingUnitCost: costInfo.brandingUnitCost,
          brandingSetupCost: costInfo.brandingSetupCost,
          totalBaseCost: costInfo.totalBaseCost,
          newPriceStr: finalPriceStr
        });
      }

      const { skuMap, titleMap } = await lookupShopifyVariantsBatch(
        validProducts,
        SHOPIFY_STORE,
        SHOPIFY_TOKEN,
        enableTitleFallback
      );

      const updatesByProduct = {};
      for (const prod of validProducts) {
        let matches = skuMap.get(prod.skuLower);
        let matchSource = 'sku';

        if ((!matches || matches.length === 0) && enableTitleFallback) {
          matches = titleMap.get(prod.cleanTitle);
          matchSource = 'nama_produk (sku null)';
        }

        if (!matches || matches.length === 0) {
          sessionNotFound++;
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
              matchSource,
              minQty: prod.minQty,
              totalBaseCost: prod.totalBaseCost,
              currentShopifyPrice: variant.currentPrice,
              newPriceStr: prod.newPriceStr
            });
          } else {
            sessionUnchanged++;
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
                sessionUpdated++;
                if (updatedDetails.length < 50) {
                  updatedDetails.push({
                    sku: item.sku,
                    cocok_via: item.matchSource,
                    qty_terendah: item.minQty,
                    total_modal_per_unit: item.totalBaseCost,
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

    accChecked += sessionChecked;
    accUpdated += sessionUpdated;
    accUnchanged += sessionUnchanged;
    accSkipped += sessionSkipped;
    accNotFound += sessionNotFound;

    const lastProcessedPage = currentPage - 1;
    const isFinished = currentPage > totalPages;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const paramQuery = detectedPageParam ? `&p_param=${detectedPageParam}` : '';
    const titleQuery = enableTitleFallback ? '&match_title=1' : '';
    const accQuery = `&acc_checked=${accChecked}&acc_updated=${accUpdated}&acc_unchanged=${accUnchanged}&acc_skipped=${accSkipped}&acc_notfound=${accNotFound}`;
    const nextUrl = `${protocol}://${host}/api/sync?page=${currentPage}${paramQuery}${titleQuery}${accQuery}`;

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
      rangkuman_kumulatif_dari_halaman_1: {
        total_produk_trends_dicek: accChecked,
        total_varian_diubah: accUpdated,
        varian_harga_sudah_sesuai: accUnchanged,
        produk_tanpa_harga_dilewati: accSkipped,
        sku_tidak_ada_di_shopify: accNotFound
      },
      rangkuman_sesi_halaman_ini: {
        produk_trends_dicek: sessionChecked,
        varian_diubah: sessionUpdated,
        varian_harga_sudah_sesuai: sessionUnchanged,
        produk_tanpa_harga_dilewati: sessionSkipped,
        sku_tidak_ada_di_shopify: sessionNotFound
      },
      halaman_berikutnya: isFinished ? null : currentPage,
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
          <h2>Sinkronisasi Harga Trends.nz → Shopify</h2>
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