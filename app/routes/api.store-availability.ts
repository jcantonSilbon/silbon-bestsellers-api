import type { LoaderFunctionArgs } from "react-router";

/** ------- CORS ------- */
const EXTRA = (process.env.CORS_EXTRA_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set<string>([
  "https://www.silbonshop.com",
  "https://silbonshop.com",
  "https://silbon-store.myshopify.com", // preview
  "https://admin.shopify.com", // editor
  ...EXTRA,
]);

function isAllowedOrigin(origin: string | null) {
  if (!origin) return false;
  for (const o of ALLOWED_ORIGINS) {
    if (origin.toLowerCase().startsWith(o.toLowerCase())) return true;
  }
  return false;
}

function corsHeaders(origin: string | null) {
  const allowOrigin = isAllowedOrigin(origin)
    ? origin!
    : "https://www.silbonshop.com";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "max-age=60",
  };
}

/** ------- Admin GraphQL (app de inventario) ------- */

async function adminInventoryGQL<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const shop =
    process.env.INVENTORY_SHOP_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN!;
  const token =
    process.env.INVENTORY_ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN!;

  const url = `https://${shop}/admin/api/2024-10/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.errors) {
    throw {
      status: res.status,
      statusText: res.statusText,
      errors: json.errors,
      body: json,
    };
  }

  return json.data as T;
}

/** ------- Tipos de respuesta ------- */

type InventoryLevelNode = {
  quantities: Array<{
    name: string;
    quantity: number;
  }>;
  location: {
    id: string;
    name: string;
    address?: {
      city?: string | null;
      provinceCode?: string | null;
      countryCode?: string | null;
      zip?: string | null;
    } | null;
  };
};

type InventoryByVariantRes = {
  productVariant: {
    id: string;
    sku: string;
    inventoryItem: {
      inventoryLevels: {
        edges: { node: InventoryLevelNode }[];
      };
    };
  } | null;
};

type InventoryBySkuRes = {
  inventoryItems: {
    edges: {
      node: {
        sku: string;
        inventoryLevels: {
          edges: { node: InventoryLevelNode }[];
        };
      };
    }[];
  };
};

/** ------- Helper normalización ------- */

function normalizeProvinceList(param: string | null): string[] {
  if (!param) return [];
  return param
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

/** ------- Loader ------- */

export async function loader({ request }: LoaderFunctionArgs) {
  const origin = request.headers.get("Origin");

  // Preflight CORS
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";

  const variantId = url.searchParams.get("variantId");
  const sku = url.searchParams.get("sku");

  // Filtro por provincia (códigos Shopify tipo SE, CO, MA, etc.)
  const provinceParam = url.searchParams.get("province");
  const provinces = normalizeProvinceList(provinceParam);

  if (!variantId && !sku) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Missing sku or variantId",
      }),
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  try {
    let usedSku: string;
    let levels: InventoryLevelNode[] = [];

    if (variantId) {
      // Convertir ID numérico a GID si es necesario
      const gid = variantId.startsWith("gid://")
        ? variantId
        : `gid://shopify/ProductVariant/${variantId}`;

      // --- Query por variantId ---
      const QUERY = `
        query InventoryByVariant($id: ID!) {
          productVariant(id: $id) {
            id
            sku
            inventoryItem {
              inventoryLevels(first: 100) {
                edges {
                  node {
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                    location {
                      id
                      name
                      address {
                        city
                        provinceCode
                        countryCode
                        zip
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const data = await adminInventoryGQL<InventoryByVariantRes>(QUERY, {
        id: gid,
      });

      if (!data.productVariant || !data.productVariant.inventoryItem) {
        throw {
          message: "Variant not found or missing inventoryItem",
          raw: data,
        };
      }

      usedSku = data.productVariant.sku;
      levels =
        data.productVariant.inventoryItem.inventoryLevels.edges.map(
          (e) => e.node,
        );
    } else {
      // --- Query por SKU ---
      const QUERY = `
        query InventoryBySku($query: String!) {
          inventoryItems(first: 1, query: $query) {
            edges {
              node {
                sku
                inventoryLevels(first: 100) {
                  edges {
                    node {
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                      location {
                        id
                        name
                        address {
                          city
                          provinceCode
                          countryCode
                          zip
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const data = await adminInventoryGQL<InventoryBySkuRes>(QUERY, {
        query: `sku:${sku}`,
      });

      const first = data.inventoryItems.edges[0]?.node;
      if (!first) {
        throw {
          message: "Inventory item not found for SKU",
          raw: data,
        };
      }

      usedSku = first.sku;
      levels = first.inventoryLevels.edges.map((e) => e.node);
    }

    // Normalizamos respuesta
    let locations = levels
      .map((lvl) => {
        const availableQty = lvl.quantities.find(
          (q) => q.name === "available",
        );
        return {
          id: lvl.location.id,
          name: lvl.location.name,
          available: availableQty?.quantity ?? 0,
          city: lvl.location.address?.city ?? null,
          provinceCode: lvl.location.address?.provinceCode ?? null,
          countryCode: lvl.location.address?.countryCode ?? null,
          zip: lvl.location.address?.zip ?? null,
        };
      })
      .filter((loc) => loc.available > 0);

    // Filtro por provincias si viene ?province=SE,CO,...
    if (provinces.length) {
      locations = locations.filter((loc) => {
        if (!loc.provinceCode) return false;
        return provinces.includes(loc.provinceCode.toUpperCase());
      });
    }

    const body: any = {
      ok: true,
      sku: usedSku,
      locations,
    };

    if (debug) {
      body.debug = {
        totalLevels: levels.length,
        filteredByProvinces: provinces,
      };
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: corsHeaders(origin),
    });
  } catch (e: any) {
    const body: any = {
      ok: false,
      error: "Inventory query failed",
    };

    if (debug) {
      body.details = e;
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: corsHeaders(origin),
    });
  }
}
