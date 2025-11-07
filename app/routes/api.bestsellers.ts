import type { LoaderFunctionArgs } from "react-router";

/* ========================= C O R S ========================= */
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
  for (const o of ALLOWED_ORIGINS) if (origin.toLowerCase().startsWith(o.toLowerCase())) return true;
  return false;
}

function corsHeaders(origin: string | null) {
  const allowOrigin = isAllowedOrigin(origin) ? origin! : "https://www.silbonshop.com";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "max-age=60",
  };
}

/* ======================= A D M I N  G Q L ======================= */
type GQLError = { message: string; extensions?: Record<string, unknown> };
type GraphQLResponse<T> = { data?: T; errors?: GQLError[] };

// Admin GQL con soporte de AbortSignal
async function adminGQL<
  TData = unknown,
  TVars extends Record<string, unknown> = Record<string, unknown>
>(query: string, variables?: TVars, signal?: AbortSignal): Promise<TData> {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN!; // p.ej. silbon-store.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_TOKEN!; // Admin access token
  const url = `https://${shop}/admin/api/2024-10/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  const json = (await r.json().catch(() => ({}))) as GraphQLResponse<TData>;
  if (!r.ok || json.errors?.length) {
    throw { status: r.status, statusText: r.statusText, errors: json.errors, body: json } as const;
  }
  return (json.data as TData) ?? (null as unknown as TData);
}

// Wrapper con timeout para evitar cuelgues por página
async function adminGQLWithTimeout<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  ms = 15000
): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await adminGQL<T>(query, variables, ac.signal);
  } finally {
    clearTimeout(t);
  }
}

/* ==================== S E G M E N T O S ==================== */
type Segment = "man" | "woman" | "teens" | "kids";

function parseSegments(url: URL): Set<Segment> {
  const single = (url.searchParams.get("segment") || "").toLowerCase().trim();
  const multi = (url.searchParams.get("segments") || "").toLowerCase();

  let list: string[] = [];
  if (multi) list = multi.split(",").map((s) => s.trim()).filter(Boolean);
  else if (single && single !== "all") list = [single];

  const s = new Set<Segment>();
  for (const v of list) {
    if (v === "man" || v === "hombre") s.add("man");
    if (v === "woman" || v === "mujer") s.add("woman");
    if (v === "teens") s.add("teens");
    if (v === "kids" || v === "niños" || v === "ninos") s.add("kids");
  }
  return s; // vacío => sin filtro
}

// helpers de normalizado y tokens
function norm(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function tokenize(s: string): string[] {
  return norm(s).split(/[^a-z0-9:]+/).filter(Boolean);
}
function tokenSet(hay: string | string[]): Set<string> {
  const arr = Array.isArray(hay) ? hay : [hay];
  const out = new Set<string>();
  for (const v of arr) for (const t of tokenize(v)) out.add(t);
  return out;
}
function hasAnyToken(hay: Set<string>, needles: readonly string[]) {
  for (const n of needles) if (hay.has(norm(n))) return true;
  return false;
}

/** Evita falsos positivos woman→man, y respeta `gender:*` si existe */
function passSegments(
  p: { tags?: string[]; productType?: string },
  segments: Set<Segment>
) {
  if (!segments.size) return true;

  // 1) Si hay tag explícito gender:*
  const genderTag = (p.tags || [])
    .map((t) => t.toLowerCase().trim())
    .find((t) => t.startsWith("gender:"));
  if (genderTag) {
    const g = genderTag.replace("gender:", "") as Segment;
    return segments.has(g);
  }

  // 2) Matching por token exacto
  const tagsTokens = tokenSet(p.tags || []);
  const ptTokens = tokenSet(p.productType || "");

  const TOK = {
    man: ["gender:man", "gender:men", "man", "men", "caballero", "mens", "hombre", "hombres"] as const,
    woman: ["gender:woman", "woman", "women", "mujer", "mujeres", "dama", "womens", "ladies", "fem"] as const,
    teens: ["segment:teens", "teen", "teens", "juvenil", "adolesc"] as const,
    kids: ["segment:kids", "kid", "kids", "niño", "nino", "niña", "nina", "infantil", "children", "child"] as const,
  };

  const okMan = hasAnyToken(tagsTokens, TOK.man) || hasAnyToken(ptTokens, TOK.man);
  const okWoman = hasAnyToken(tagsTokens, TOK.woman) || hasAnyToken(ptTokens, TOK.woman);
  const okTeens = hasAnyToken(tagsTokens, TOK.teens) || hasAnyToken(ptTokens, TOK.teens);
  const okKids = hasAnyToken(tagsTokens, TOK.kids) || hasAnyToken(ptTokens, TOK.kids);

  // 3) Exclusividad entre man/woman cuando sólo marcan uno
  const wantsMan = segments.has("man");
  const wantsWoman = segments.has("woman");

  if (wantsMan && !wantsWoman) return okMan && !okWoman;
  if (wantsWoman && !wantsMan) return okWoman && !okMan;

  // 4) Si marcan ambos, vale cualquiera
  if (wantsMan && wantsWoman && (okMan || okWoman)) return true;

  // 5) Teens/Kids combinables
  if (segments.has("teens") && okTeens) return true;
  if (segments.has("kids") && okKids) return true;

  return false;
}

/* ======================== C A C H É ======================== */
type Resp = { handles: string[]; meta?: Record<string, unknown> };

const MEM_TTL = Number(process.env.BESTSELLERS_TTL || 900); // segundos
const mem = new Map<string, { at: number; value: Resp }>();

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key: string): Promise<Resp | null> {
  if (!R_URL || !R_TOKEN) return null;
  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as { result?: string } | null;
  return j?.result ? (JSON.parse(j.result) as Resp) : null;
}
async function redisSet(key: string, value: Resp, ttlSec: number) {
  if (!R_URL || !R_TOKEN) return;
  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value), EX: ttlSec }),
  }).catch(() => {});
}

const CACHE_VER = "v4";
function k(fromISO: string, toISO: string, segs: Set<Segment>, limit: number) {
  return `bestsellers:${CACHE_VER}:${fromISO}:${toISO}:${[...segs].sort().join(",")}:${limit}`;
}

/* ===================== F E C H A S  U T C ===================== */
function startOfDayUTC(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function endOfDayUTC(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/* ======================= L O A D E R ======================= */
export async function loader({ request }: LoaderFunctionArgs) {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "16", 10), 60);
  const segments = parseSegments(url);
  const debug = url.searchParams.get("debug") === "1";
  const nocache = url.searchParams.get("nocache") === "1";

  // Fechas (normalizadas a bordes de día UTC para mejorar cache hit)
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");

  const toDateRaw = toParam ? new Date(toParam) : new Date();
  const fromDateRaw = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const toISO = endOfDayUTC(toDateRaw).toISOString();
  const fromISO = startOfDayUTC(fromDateRaw).toISOString();

  const resp: Resp = { handles: [] };
  if (debug) {
    resp.meta = {
      shopFromEnv: process.env.SHOPIFY_SHOP_DOMAIN,
      range: { from: fromISO, to: toISO },
      segments: [...segments],
      step: "start",
    };
  }

  // Caché
  const key = k(fromISO, toISO, segments, limit);
  const now = Date.now();

  // 1) Memory cache
  if (!nocache) {
    const m = mem.get(key);
    if (m && now - m.at < MEM_TTL * 1000) {
      if (debug) (m.value.meta ??= {}).cache = "memory";
      return new Response(JSON.stringify(m.value), { headers: corsHeaders(origin) });
    }
  }

  // 2) Redis cache
  const redisCached = !nocache ? await redisGet(key) : null;
  if (redisCached) {
    if (debug) (redisCached.meta ??= {}).cache = "redis";
    mem.set(key, { at: now, value: redisCached });
    return new Response(JSON.stringify(redisCached), { headers: corsHeaders(origin) });
  }

  try {
    // Smokes (tipos mínimos)
    type ProdSmoke = { products: { nodes: Array<{ id: string; handle: string }> } };
    type OrdSmoke = { orders: { nodes: Array<{ id: string }> } };

    const prodSmoke = await adminGQLWithTimeout<ProdSmoke>(
      `query { products(first:1){ nodes { id handle } } }`,
      undefined,
      10000
    );
    const ordersSmoke = await adminGQLWithTimeout<OrdSmoke>(
      `query { orders(first:1){ nodes { id } } }`,
      undefined,
      10000
    );

    if (debug) {
      (resp.meta ??= {}).prodSmoke = prodSmoke?.products?.nodes?.length ?? 0;
      (resp.meta ??= {}).ordersSmoke = ordersSmoke?.orders?.nodes?.length ?? 0;
    }

    // Query real (últimos 30d o rango manual)
    const searchBase = `financial_status:paid created_at:>=${fromISO} created_at:<=${toISO}`;
    const ORDERS_QUERY = `
      query Orders($cursor:String) {
        orders(first: 100, after:$cursor, query: "${searchBase.replace(/"/g, '\\"')}") {
          pageInfo { hasNextPage endCursor }
          nodes {
            lineItems(first: 100) {
              nodes {
                quantity
                product { id handle tags productType }
              }
            }
          }
        }
      }`;

    type OrdersPage = {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          lineItems: { nodes: Array<{ quantity: number; product: { id: string; handle: string; tags?: string[]; productType?: string } | null }> };
        }>;
      };
    };

    const qtyByProductId = new Map<string, number>();
    let cursor: string | null = null;
    let pages = 0, scanned = 0;

    do {
      const data = await adminGQLWithTimeout<OrdersPage>(ORDERS_QUERY, { cursor }, 15000);
      const { nodes, pageInfo } = data.orders;
      pages++;
      for (const o of nodes) {
        for (const li of o.lineItems.nodes) {
          scanned++;
          const p = li.product;
          if (!p) continue;
          if (!passSegments({ tags: p.tags, productType: p.productType }, segments)) continue;
          qtyByProductId.set(p.id, (qtyByProductId.get(p.id) || 0) + li.quantity);
        }
      }
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);

    if (debug) {
      (resp.meta ??= {}).pagesFetched = pages;
      (resp.meta ??= {}).lineItemsScanned = scanned;
      (resp.meta ??= {}).uniqueProducts = qtyByProductId.size;
    }

    if (!qtyByProductId.size) {
      mem.set(key, { at: now, value: resp });
      redisSet(key, resp, MEM_TTL).catch(() => {});
      return new Response(JSON.stringify(resp), { headers: corsHeaders(origin) });
    }

    const topIds = [...qtyByProductId.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    const NODES_QUERY = `query N($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle } } }`;
    type NodesResp = { nodes: Array<{ id?: string; handle?: string } | null> };
    const nd = await adminGQLWithTimeout<NodesResp>(NODES_QUERY, { ids: topIds }, 10000);

    resp.handles = (nd.nodes || [])
      .filter(Boolean)
      .map((n) => n!.handle)
      .filter((h): h is string => Boolean(h));

    // Cache write
    mem.set(key, { at: now, value: resp });
    redisSet(key, resp, MEM_TTL).catch(() => {});

    return new Response(JSON.stringify(resp), { headers: corsHeaders(origin) });
  } catch (e: unknown) {
    // stale-if-error: si tenemos algo previo en Redis (o en memoria), devuélvelo
    const stale = mem.get(key)?.value || redisCached;
    if (stale) {
      if (debug) (stale.meta ??= {}).stale = true;
      return new Response(JSON.stringify(stale), { headers: corsHeaders(origin) });
    }

    if (debug) {
      (resp.meta ??= {}).error = e;
      (resp.meta ??= {}).tip =
        "401/403 ⇒ token/dominio. 'Parse error' ⇒ GraphQL. Prueba a acotar fechas o revisar scopes.";
    }
    return new Response(JSON.stringify(resp), { status: 200, headers: corsHeaders(origin) });
  }
}
