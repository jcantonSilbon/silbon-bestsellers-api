import type { LoaderFunctionArgs } from "react-router";

/* ========================= C O R S ========================= */
const EXTRA = (process.env.CORS_EXTRA_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set<string>([
  "https://www.silbonshop.com",
  "https://silbonshop.com",
  "https://silbon-store.myshopify.com",
  "https://admin.shopify.com",
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

async function adminGQL<
  TData = unknown,
  TVars extends Record<string, unknown> = Record<string, unknown>
>(query: string, variables?: TVars): Promise<TData> {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN!;
  const token = process.env.SHOPIFY_ADMIN_TOKEN!;
  const url = `https://${shop}/admin/api/2024-10/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await r.json().catch(() => ({}))) as GraphQLResponse<TData>;
  if (!r.ok || json.errors?.length) {
    throw { status: r.status, statusText: r.statusText, errors: json.errors, body: json } as const;
  }
  return (json.data as TData) ?? (null as unknown as TData);
}

/* ==================== S E G M E N T O S ==================== */
type Segment = "man" | "woman" | "teens" | "kids" | "girl";

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
    if (v === "kids" || v === "niño" || v === "nino" || v === "boy") s.add("kids");
    if (v === "girl" || v === "niña" || v === "nina") s.add("girl");
  }
  return s;
}

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

function passSegments(p: { tags?: string[]; productType?: string }, segments: Set<Segment>) {
  if (!segments.size) return true;

  const genderTag = (p.tags || [])
    .map((t) => t.toLowerCase().trim())
    .find((t) => t.startsWith("gender:"));
  if (genderTag) {
    const g = genderTag.replace("gender:", "") as Segment;
    return segments.has(g);
  }

  const tagsTokens = tokenSet(p.tags || []);
  const ptTokens = tokenSet(p.productType || "");

  const TOK = {
    man: ["gender:man", "gender:men", "man", "men", "caballero", "mens", "hombre", "hombres"] as const,
    woman: ["gender:woman", "woman", "women", "mujer", "mujeres", "dama", "womens", "ladies", "fem"] as const,
    teens: ["segment:teens", "teen", "teens", "juvenil", "adolesc"] as const,
    kids: ["segment:kids", "kids", "kid", "niño", "nino", "niños", "ninos", "boy", "boys"] as const,
    girl: ["segment:girl", "girl", "girls", "niña", "nina", "niñas", "ninas"] as const,
  };

  const okMan = hasAnyToken(tagsTokens, TOK.man) || hasAnyToken(ptTokens, TOK.man);
  const okWoman = hasAnyToken(tagsTokens, TOK.woman) || hasAnyToken(ptTokens, TOK.woman);
  const okTeens = hasAnyToken(tagsTokens, TOK.teens) || hasAnyToken(ptTokens, TOK.teens);
  const okKids = hasAnyToken(tagsTokens, TOK.kids) || hasAnyToken(ptTokens, TOK.kids);
  const okGirl = hasAnyToken(tagsTokens, TOK.girl) || hasAnyToken(ptTokens, TOK.girl);

  const wantsMan = segments.has("man");
  const wantsWoman = segments.has("woman");

  if (wantsMan && !wantsWoman) return okMan && !okWoman;
  if (wantsWoman && !wantsMan) return okWoman && !okMan;
  if (wantsMan && wantsWoman && (okMan || okWoman)) return true;

  if (segments.has("teens") && okTeens) return true;
  if (segments.has("kids") && okKids) return true;
  if (segments.has("girl") && okGirl) return true;

  return false;
}

/* ======================== F E C H A S (FIX) ======================== */
// YYYY-MM-DD => UTC start/end of day
function parseDateParamUTC(dateStr: string, endOfDay: boolean) {
  if (dateStr.includes("T")) return new Date(dateStr);

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return new Date(dateStr);

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);

  return endOfDay
    ? new Date(Date.UTC(y, mo, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, mo, d, 0, 0, 0, 0));
}

/* ======================== C A N A L (FIX) ======================== */
function isOnlineSource(sourceName?: string | null) {
  const s = String(sourceName || "").toLowerCase().trim();

  // Si Shopify no lo manda, NO filtres (fallback seguro)
  if (!s) return true;

  // POS fuera
  if (s.includes("pos")) return false;

  // Online: Shopify devuelve muchísimas veces "checkout" o "shopify"
  return (
    s.includes("web") ||
    s.includes("online") ||
    s.includes("checkout") ||
    s.includes("shopify")
  );
}

/* ======================== C A C H É ======================== */
type Resp = { handles: string[]; meta?: Record<string, unknown> };

const MEM_TTL = Number(process.env.BESTSELLERS_TTL || 900);
const mem = new Map<string, { at: number; value: Resp }>();

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key: string): Promise<Resp | null> {
  if (!R_URL || !R_TOKEN) return null;
  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOKEN}` },
  });
  if (!r.ok) return null;

  const j = (await r.json().catch(() => null)) as { result?: string; value?: string } | null;

  // Upstash puede devolver "result" o "value"
  const packed = j?.result || j?.value;
  if (!packed) return null;

  try {
    return JSON.parse(packed) as Resp;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: Resp, ttlSec: number) {
  if (!R_URL || !R_TOKEN) return;
  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value), EX: ttlSec }),
  }).catch(() => {});
}

const CACHE_VER = "v8";
function k(fromISO: string, toISO: string, segs: Set<Segment>, limit: number, channel: string) {
  return `bestsellers:${CACHE_VER}:${fromISO}:${toISO}:${[...segs].sort().join(",")}:${limit}:${channel}`;
}

/* ======================= L O A D E R ======================= */
export async function loader({ request }: LoaderFunctionArgs) {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "16", 10), 60);
  const segments = parseSegments(url);
  const debug = url.searchParams.get("debug") === "1";
  const nocache = url.searchParams.get("nocache") === "1";
  const useSnapshot = url.searchParams.get("snapshot") !== "0"; // por defecto usamos snapshot

  const resp: Resp = { handles: [] };

  // 1) Intentar SNAPSHOT primero (ultrarrápido)
  if (useSnapshot) {
    const sKey = snapKey(segments, limit);
    const snap = await redisGet(sKey);
    if (snap && Array.isArray(snap.handles)) {
      if (debug) (snap.meta ??= {}).source = "snapshot";
      return new Response(JSON.stringify(snap), {
        headers: { ...corsHeaders(origin), "X-Bestsellers-Source": "snapshot" }
      });
    }
  }

  // 2) Fallback a cálculo en vivo (por si snapshot aún no existe)
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");

  const toDate = toParam ? parseDateParamUTC(toParam, true) : new Date();
  const fromDate = fromParam
    ? parseDateParamUTC(fromParam, false)
    : new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const toISO = toDate.toISOString();
  const fromISO = fromDate.toISOString();

  const resp: Resp = { handles: [] };
  if (debug) {
    resp.meta = {
      shopFromEnv: process.env.SHOPIFY_SHOP_DOMAIN,
      range: { from: fromISO, to: toISO },
      segments: [...segments],
      channelFilter,
      step: "start",
    };
  }

  // =========================
  // Caché
  // =========================
  const key = k(fromISO, toISO, segments, limit, channelFilter);
  const now = Date.now();

  if (!nocache) {
    const m = mem.get(key);
    if (m && now - m.at < MEM_TTL * 1000) {
      if (debug) (m.value.meta ??= {}).cache = "memory";
      return new Response(JSON.stringify(m.value), { headers: corsHeaders(origin) });
    }

    const rHit = await redisGet(key);
    if (rHit) {
      if (debug) (rHit.meta ??= {}).cache = "redis";
      mem.set(key, { at: now, value: rHit });
      return new Response(JSON.stringify(rHit), { headers: corsHeaders(origin) });
    }
  }

  try {
    type ProdSmoke = { products: { nodes: Array<{ id: string; handle: string }> } };
    type OrdSmoke = { orders: { nodes: Array<{ id: string }> } };

    const prodSmoke = await adminGQL<ProdSmoke>(`query { products(first:1){ nodes { id handle } } }`);
    const ordersSmoke = await adminGQL<OrdSmoke>(`query { orders(first:1){ nodes { id } } }`);

    if (debug) {
      (resp.meta ??= {}).prodSmoke = prodSmoke?.products?.nodes?.length ?? 0;
      (resp.meta ??= {}).ordersSmoke = ordersSmoke?.orders?.nodes?.length ?? 0;
    }

    const searchBase = `financial_status:paid created_at:>=${fromISO} created_at:<=${toISO}`;

    const ORDERS_QUERY = `
      query Orders($cursor:String) {
        orders(first: 100, after:$cursor, query: "${searchBase.replace(/"/g, '\\"')}") {
          pageInfo { hasNextPage endCursor }
          nodes {
            sourceName
            cancelledAt
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
          sourceName?: string | null;
          cancelledAt?: string | null;
          lineItems: {
            nodes: Array<{
              quantity: number;
              product: { id: string; handle: string; tags?: string[]; productType?: string } | null;
            }>;
          };
        }>;
      };
    };

    const qtyByProductId = new Map<string, number>();
    let cursor: string | null = null;

    let pages = 0,
      scanned = 0,
      skippedByChannel = 0,
      skippedByCancelled = 0;

    do {
      const data = await adminGQL<OrdersPage>(ORDERS_QUERY, { cursor });
      const { nodes, pageInfo } = data.orders;
      pages++;

      for (const o of nodes) {
        // Excluir cancelados
        if (o.cancelledAt) {
          skippedByCancelled++;
          continue;
        }

        // Canal online (FIX robusto)
        if (channelFilter === "online") {
          if (!isOnlineSource(o.sourceName)) {
            skippedByChannel++;
            continue;
          }
        }

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
      (resp.meta ??= {}).skippedByChannel = skippedByChannel;
      (resp.meta ??= {}).skippedByCancelled = skippedByCancelled;
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

    const nd = await adminGQL<NodesResp>(NODES_QUERY, { ids: topIds });

    resp.handles = (nd.nodes || [])
      .filter(Boolean)
      .map((n) => n!.handle)
      .filter((h): h is string => Boolean(h));

    mem.set(key, { at: now, value: resp });
    redisSet(key, resp, MEM_TTL).catch(() => {});

    return new Response(JSON.stringify(resp), { headers: corsHeaders(origin) });
  } catch (e: unknown) {
    if (debug) {
      (resp.meta ??= {}).error = e;
      (resp.meta ??= {}).tip =
        "401/403 ⇒ token/dominio. 'Parse error' ⇒ GraphQL. Prueba a acotar fechas o revisar scopes.";
    }
    return new Response(JSON.stringify(resp), { status: 200, headers: corsHeaders(origin) });
  }
}
