import fetch from 'node-fetch';

/**
 * Shopify <-> TRENDS NZ Price Sync
 *
 * Environment variables:
 *
 * TRENDS_API_TOKEN
 * SHOPIFY_STORE_URL
 * SHOPIFY_ADMIN_TOKEN
 *
 * Optional:
 * TRENDS_START_PAGE=1
 * TRENDS_MAX_PAGES=1000
 * TRENDS_PAGE_SIZE=100
 * MARKUP_MULTIPLIER=1.645
 * BATCH_SIZE=5
 * REQUEST_DELAY_MS=200
 * DRY_RUN=false
 */

const SHOPIFY_API_VERSION = '2026-01';

const MARKUP_MULTIPLIER = Number(
  process.env.MARKUP_MULTIPLIER || '1.645'
);

const START_PAGE = Number(
  process.env.TRENDS_START_PAGE || '1'
);

const MAX_PAGES = Number(
  process.env.TRENDS_MAX_PAGES || '1000'
);

const BATCH_SIZE = Number(
  process.env.BATCH_SIZE || '5'
);

const REQUEST_DELAY_MS = Number(
  process.env.REQUEST_DELAY_MS || '200'
);

const DRY_RUN =
  String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';


/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Get environment variables
 */
function getConfig() {
  const TRENDS_TOKEN = process.env.TRENDS_API_TOKEN;

  const SHOPIFY_STORE = (process.env.SHOPIFY_STORE_URL || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!TRENDS_TOKEN) {
    throw new Error('Missing TRENDS_API_TOKEN');
  }

  if (!SHOPIFY_STORE) {
    throw new Error('Missing SHOPIFY_STORE_URL');
  }

  if (!SHOPIFY_TOKEN) {
    throw new Error('Missing SHOPIFY_ADMIN_TOKEN');
  }

  if (!Number.isFinite(MARKUP_MULTIPLIER) || MARKUP_MULTIPLIER <= 0) {
    throw new Error('Invalid MARKUP_MULTIPLIER');
  }

  return {
    TRENDS_TOKEN,
    SHOPIFY_STORE,
    SHOPIFY_TOKEN
  };
}


/**
 * TRENDS API request
 */
async function fetchTrendsPage(page, trendsToken) {
  const authHeader = trendsToken.startsWith('Bearer')
    ? trendsToken
    : `Bearer ${trendsToken}`;

  const url =
    `https://au.api.trends.nz/api/v1/products.json?page=${page}`;

  console.log(`[TRENDS] Fetching page ${page}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json'
    }
  });

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `TRENDS returned invalid JSON on page ${page}: ${rawText.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `TRENDS API error page ${page}: HTTP ${response.status} - ${JSON.stringify(data)}`
    );
  }

  return data;
}


/**
 * Extract product array from TRENDS response
 */
function extractProducts(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.products)) {
    return data.products;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  return [];
}


/**
 * Extract SKU from TRENDS product
 */
function getSku(item) {
  const sku =
    item?.code ??
    item?.sku ??
    item?.product_code ??
    item?.productCode;

  if (sku === null || sku === undefined) {
    return null;
  }

  return String(sku).trim();
}


/**
 * Extract price from TRENDS product
 */
function getBasePrice(item) {
  if (
    item?.pricing?.prices &&
    Array.isArray(item.pricing.prices) &&
    item.pricing.prices.length > 0
  ) {
    const value = item.pricing.prices[0]?.price;

    if (
      value !== null &&
      value !== undefined &&
      value !== ''
    ) {
      const price = Number(value);

      if (Number.isFinite(price)) {
        return price;
      }
    }
  }

  if (
    item?.price !== null &&
    item?.price !== undefined &&
    item?.price !== ''
  ) {
    const price = Number(item.price);

    if (Number.isFinite(price)) {
      return price;
    }
  }

  return null;
}


/**
 * Calculate Shopify selling price
 */
function calculateShopifyPrice(basePrice) {
  const calculated =
    Number(basePrice) * MARKUP_MULTIPLIER;

  if (!Number.isFinite(calculated)) {
    return null;
  }

  return calculated.toFixed(2);
}


/**
 * Shopify GraphQL request
 */
async function shopifyGraphQL(
  query,
  variables,
  config,
  attempt = 1
) {
  const url =
    `https://${config.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': config.SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Shopify returned invalid JSON: ${rawText.slice(0, 500)}`
    );
  }

  /**
   * Retry temporary HTTP errors
   */
  if (
    [429, 500, 502, 503, 504].includes(response.status) &&
    attempt < 4
  ) {
    const delay = attempt * 1500;

    console.warn(
      `[SHOPIFY] HTTP ${response.status}. Retrying in ${delay}ms...`
    );

    await sleep(delay);

    return shopifyGraphQL(
      query,
      variables,
      config,
      attempt + 1
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  /**
   * GraphQL top-level errors
   */
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL errors: ${JSON.stringify(data.errors)}`
    );
  }

  return data;
}


/**
 * Find Shopify variant by SKU
 *
 * We still use SKU lookup here for compatibility with your
 * current setup. Later, we can cache SKU -> Variant ID.
 */
async function findShopifyVariant(sku, config) {
  const query = `
    query FindVariantBySKU($query: String!) {
      productVariants(first: 10, query: $query) {
        edges {
          node {
            id
            sku
            price
            product {
              id
              title
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    query,
    {
      query: `sku:${escapeShopifyQueryValue(sku)}`
    },
    config
  );

  const edges =
    data?.data?.productVariants?.edges || [];

  if (edges.length === 0) {
    return null;
  }

  /**
   * Try exact SKU match first.
   */
  const exactMatch = edges.find(
    (edge) =>
      String(edge?.node?.sku || '').trim() === sku
  );

  if (exactMatch) {
    return exactMatch.node;
  }

  /**
   * Fallback to first result.
   */
  return edges[0]?.node || null;
}


/**
 * Escape special Shopify search characters
 */
function escapeShopifyQueryValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}


/**
 * Update Shopify variant price
 */
async function updateShopifyVariantPrice(
  variant,
  newPrice,
  config
) {
  if (DRY_RUN) {
    console.log(
      `[DRY RUN] Would update ${variant.sku}: ${variant.price} -> ${newPrice}`
    );

    return {
      success: true,
      dryRun: true,
      variantId: variant.id,
      oldPrice: variant.price,
      newPrice
    };
  }

  const mutation = `
    mutation UpdateVariantPrice(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: $variants
      ) {
        product {
          id
        }

        productVariants {
          id
          price
          sku
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    productId: variant.product.id,
    variants: [
      {
        id: variant.id,
        price: newPrice
      }
    ]
  };

  const data = await shopifyGraphQL(
    mutation,
    variables,
    config
  );

  const result =
    data?.data?.productVariantsBulkUpdate;

  if (!result) {
    throw new Error(
      `Shopify returned no productVariantsBulkUpdate result: ${JSON.stringify(data)}`
    );
  }

  if (
    Array.isArray(result.userErrors) &&
    result.userErrors.length > 0
  ) {
    throw new Error(
      `Shopify userErrors: ${JSON.stringify(result.userErrors)}`
    );
  }

  const updatedVariant =
    result.productVariants?.find(
      (item) => item.id === variant.id
    );

  return {
    success: true,
    dryRun: false,
    variantId: variant.id,
    oldPrice: variant.price,
    newPrice: updatedVariant?.price || newPrice
  };
}


/**
 * Process one TRENDS product
 */
async function processProduct(item, config) {
  const sku = getSku(item);
  const basePrice = getBasePrice(item);

  if (!sku) {
    return {
      status: 'invalid',
      reason: 'SKU tidak ditemukan'
    };
  }

  if (basePrice === null) {
    return {
      status: 'invalid',
      sku,
      reason: 'Harga TRENDS tidak ditemukan'
    };
  }

  const newPrice = calculateShopifyPrice(basePrice);

  if (!newPrice) {
    return {
      status: 'invalid',
      sku,
      reason: 'Harga hasil kalkulasi tidak valid'
    };
  }

  let variant;

  try {
    variant = await findShopifyVariant(
      sku,
      config
    );
  } catch (error) {
    return {
      status: 'failed',
      sku,
      trendsPrice: basePrice,
      newPrice,
      error: `Shopify lookup failed: ${error.message}`
    };
  }

  if (!variant) {
    return {
      status: 'not_found',
      sku,
      trendsPrice: basePrice,
      newPrice
    };
  }

  const currentPrice = Number(variant.price);

  const newPriceNumber = Number(newPrice);

  if (
    Number.isFinite(currentPrice) &&
    currentPrice.toFixed(2) ===
      newPriceNumber.toFixed(2)
  ) {
    return {
      status: 'unchanged',
      sku,
      trendsPrice: basePrice,
      shopifyPrice: currentPrice.toFixed(2)
    };
  }

  try {
    const updateResult =
      await updateShopifyVariantPrice(
        variant,
        newPrice,
        config
      );

    return {
      status: 'updated',
      sku,
      trendsPrice: basePrice,
      oldPrice: currentPrice.toFixed(2),
      newPrice,
      shopifyVariantId: variant.id,
      ...updateResult
    };
  } catch (error) {
    return {
      status: 'failed',
      sku,
      trendsPrice: basePrice,
      oldPrice: Number.isFinite(currentPrice)
        ? currentPrice.toFixed(2)
        : variant.price,
      newPrice,
      shopifyVariantId: variant.id,
      error: error.message
    };
  }
}


/**
 * Process array in controlled batches
 */
async function processInBatches(
  products,
  config
) {
  const results = [];

  for (
    let start = 0;
    start < products.length;
    start += BATCH_SIZE
  ) {
    const batch = products.slice(
      start,
      start + BATCH_SIZE
    );

    console.log(
      `[SYNC] Processing products ${start + 1}-${Math.min(
        start + BATCH_SIZE,
        products.length
      )} / ${products.length}`
    );

    const batchResults = [];

    for (const item of batch) {
      const result = await processProduct(
        item,
        config
      );

      batchResults.push(result);

      if (REQUEST_DELAY_MS > 0) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    results.push(...batchResults);

    /**
     * Small pause between batches.
     */
    if (
      start + BATCH_SIZE < products.length
    ) {
      await sleep(500);
    }
  }

  return results;
}


/**
 * Main handler
 */
export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    const config = getConfig();

    /**
     * Optional manual controls:
     *
     * /api/sync?page=1
     * /api/sync?maxPages=5
     * /api/sync?dryRun=true
     */
    const requestedPage =
      Number(req.query?.page || START_PAGE);

    const requestedMaxPages =
      Number(
        req.query?.maxPages ||
        MAX_PAGES
      );

    const requestedDryRun =
      String(
        req.query?.dryRun ||
        DRY_RUN
      ).toLowerCase() === 'true';

    /**
     * Temporarily override global dry run
     */
    const originalDryRun = globalThis.__TRENDS_DRY_RUN;

    globalThis.__TRENDS_DRY_RUN =
      requestedDryRun;

    console.log(
      '========================================'
    );

    console.log(
      '[SYNC] Starting Shopify <-> TRENDS sync'
    );

    console.log(
      `[SYNC] Start page: ${requestedPage}`
    );

    console.log(
      `[SYNC] Max pages: ${requestedMaxPages}`
    );

    console.log(
      `[SYNC] Markup multiplier: ${MARKUP_MULTIPLIER}`
    );

    console.log(
      `[SYNC] Dry run: ${requestedDryRun}`
    );

    console.log(
      '========================================'
    );

    const allProducts = [];

    let page = requestedPage;

    /**
     * Fetch all pages
     */
    while (
      page < requestedPage + requestedMaxPages
    ) {
      const trendsData =
        await fetchTrendsPage(
          page,
          config.TRENDS_TOKEN
        );

      const products =
        extractProducts(trendsData);

      console.log(
        `[TRENDS] Page ${page}: ${products.length} products`
      );

      if (products.length === 0) {
        console.log(
          `[TRENDS] Page ${page} empty. Pagination finished.`
        );

        break;
      }

      allProducts.push(...products);

      /**
       * If API returns less than expected,
       * assume this is the final page.
       *
       * This assumes the API normally returns
       * a consistent page size.
       */
      if (
        products.length < 100
      ) {
        console.log(
          `[TRENDS] Page ${page} contains less than 100 products. Assuming last page.`
        );

        break;
      }

      page++;
    }

    console.log(
      `[SYNC] Total TRENDS products: ${allProducts.length}`
    );

    /**
     * No products
     */
    if (allProducts.length === 0) {
      return res.status(200).json({
        success: true,
        message:
          'Tidak ada produk TRENDS yang ditemukan.',
        dry_run: requestedDryRun,
        duration_ms:
          Date.now() - startedAt
      });
    }

    /**
     * Process products
     *
     * IMPORTANT:
     * We use controlled sequential processing
     * to avoid hammering Shopify.
     */
    const results =
      await processInBatches(
        allProducts,
        config
      );

    /**
     * Restore global state
     */
    globalThis.__TRENDS_DRY_RUN =
      originalDryRun;

    /**
     * Summary
     */
    const summary = {
      total_trends_products:
        allProducts.length,

      updated:
        results.filter(
          (r) => r?.status === 'updated'
        ).length,

      unchanged:
        results.filter(
          (r) => r?.status === 'unchanged'
        ).length,

      not_found:
        results.filter(
          (r) => r?.status === 'not_found'
        ).length,

      failed:
        results.filter(
          (r) => r?.status === 'failed'
        ).length,

      invalid:
        results.filter(
          (r) => r?.status === 'invalid'
        ).length
    };

    console.log(
      '[SYNC] Summary:',
      JSON.stringify(summary, null, 2)
    );

    console.log(
      '========================================'
    );

    console.log(
      '[SYNC] Finished'
    );

    console.log(
      '========================================'
    );

    return res.status(200).json({
      success: true,

      dry_run: requestedDryRun,

      markup_multiplier:
        MARKUP_MULTIPLIER,

      pages_processed:
        page - requestedPage + 1,

      summary,

      updated_products:
        results.filter(
          (r) => r?.status === 'updated'
        ),

      failed_products:
        results.filter(
          (r) => r?.status === 'failed'
        ),

      not_found_products:
        results.filter(
          (r) => r?.status === 'not_found'
        ),

      invalid_products:
        results.filter(
          (r) => r?.status === 'invalid'
        ),

      duration_ms:
        Date.now() - startedAt
    });

  } catch (error) {
    console.error(
      '[SYNC] Fatal error:',
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message,
      duration_ms:
        Date.now() - startedAt
    });
  }
}