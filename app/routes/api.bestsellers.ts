import type { LoaderFunctionArgs } from "react-router";

/* ========================= C O R S ========================= */
const EXTRA = (process.env.CORS_EXTRA_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = new Set<string>([
  "https://www.silbonshop.com",
  "https://silbonshop.com",
  "https://silbon-store.myshopify.com", // preview
  "https://admin.shopify.com",          // editor
  ...EXTRA,
]);

function isAllowedOrigin(origin: string | null) {
  if (!origin) return false;
  for (const o of ALLOWED_ORIGINS)
    if (origin.toLowerCase().startsWith(o.toLowerCase())) return true;
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
>(query: string, variables?: TVars, signal?: AbortSignal): Promise<TData> {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN!;
  const token = process.env.SHOPIFY_ADMIN_TOKEN!;
  const url = `https://${shop}/admin/api/2024-10/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  const json = (await r.json().catch(() => ({}))) as GraphQLResponse<TData>;
  if (!r.ok || json.errors?.length) {
    throw { status: r.status, statusText: r.statusText, errors: json.errors, body: json } as const;
  }
  return (json.data as TData) ?? (null as unknown as TData);
}
async function adminGQLWithTimeout<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  ms = 15000
): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await adminGQL<T>(query, variables, ac.signal); }
  finally { clearTimeout(t); }
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

// normalizado tokens
function norm(s: string) { return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(); }
function tokenize(s: string): string[] { return norm(s).split(/[^a-z0-9:]+/).filter(Boolean); }
function tokenSet(hay: string | string[]): Set<string> {
  const arr = Array.isArray(hay) ? hay : [hay]; const out = new Set<string>();
  for (const v of arr) for (const t of tokenize(v)) out.add(t); return out;
}
function hasAnyToken(hay: Set<string>, needles: readonly string[]) { for (const n of needles) if (hay.has(norm(n))) return true; return false; }
function passSegments(p: { tags?: string[]; productType?: string }, segments: Set<Segment>) {
  if (!segments.size) return true;
  const genderTag = (p.tags || []).map((t) => t.toLowerCase().trim()).find((t) => t.startsWith("gender:"));
  if (genderTag) return segments.has(genderTag.replace("gender:", "") as Segment);

  const tagsTokens = tokenSet(p.tags || []), ptTokens = tokenSet(p.productType || "");
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

  const wantsMan = segments.has("man"), wantsWoman = segments.has("woman");
  if (wantsMan && !wantsWoman) return okMan && !okWoman;
  if (wantsWoman && !wantsMan) return okWoman && !okMan;
  if (wantsMan && wantsWoman && (okMan || okWoman)) return true;
  if (segments.has("teens") && okTeens) return true;
  if (segments.has("kids") && okKids) return true;
  return false;
}

/* ======================== C A C H É & S N A P ======================== */
type Resp = { handles: string[]; meta?: Record<string, unknown> };
const MEM_TTL = Number(process.env.BESTSELLERS_TTL || 900); // segundos
const mem = new Map<string, { at: number; value: Resp }>();
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Unwrap defensivo por si llega { value: "<json>", EX } o un string JSON */
function unwrapMaybeWrapped(v: any): Resp | null {
  try {
    if (typeof v === "string") return JSON.parse(v) as Resp;
    if (v && typeof v === "object" && typeof v.value === "string") {
      return JSON.parse(v.value) as Resp;
    }
    if (v && Array.isArray((v as Resp).handles)) return v as Resp;
  } catch {}
  return null;
}

async function redisGet(key: string): Promise<Resp | null> {
  if (!R_URL || !R_TOKEN) return null;

  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOKEN}` },
  });
  if (!r.ok) return null;

  const j = (await r.json().catch(() => null)) as { result?: string } | null;
  if (!j?.result) return null;

  try {
    const first = JSON.parse(j.result);
    const val = typeof first === "string" ? JSON.parse(first) : first;
    return unwrapMaybeWrapped(val);
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: Resp, ttlSec?: number) {
  if (!R_URL || !R_TOKEN) return;
  const body: any = { value: JSON.stringify(value) };
  if (ttlSec && ttlSec > 0) body.EX = ttlSec;
  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => { });
}

// Claves
const CACHE_VER = "v5";
function liveKey(fromISO: string, toISO: string, segs: Set<Segment>, limit: number) {
  return `bestsellers:${CACHE_VER}:live:${fromISO}:${toISO}:${[...segs].sort().join(",")}:${limit}`;
}
// snapshot semanal (últimos 30 días, independiente de fecha exacta de consulta)
function snapKey(segs: Set<Segment>, limit: number) {
  return `bestsellers:${CACHE_VER}:snapshot:last30:${[...segs].sort().join(",")}:${limit}`;
}

/* ===================== F E C H A S  U T C ===================== */
function startOfDayUTC(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function endOfDayUTC(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)); }

/* ======================= L O A D E R  (SERVE) ======================= */
export async function loader({ request }: LoaderFunctionArgs) {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

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
  const toDateRaw = toParam ? new Date(toParam) : new Date();
  const fromDateRaw = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const toISO = endOfDayUTC(toDateRaw).toISOString();
  const fromISO = startOfDayUTC(fromDateRaw).toISOString();

  if (debug) {
    resp.meta = {
      ...(resp.meta || {}),
      shopFromEnv: process.env.SHOPIFY_SHOP_DOMAIN,
      range: { from: fromISO, to: toISO },
      segments: [...segments],
      step: "live-start",
    };
  }

  // Caché live (mem/redis) para no repetir cálculos en caliente
  const key = liveKey(fromISO, toISO, segments, limit);
  const now = Date.now();

  if (!nocache) {
    // MEMORIA
    const m = mem.get(key);
    if (m && now - m.at < MEM_TTL * 1000) {
      const clean = unwrapMaybeWrapped(m.value);
      if (clean) {
        if (debug) (clean.meta ??= {}).cache = "memory";
        return new Response(JSON.stringify(clean), { headers: corsHeaders(origin) });
      }
      // si estaba mal, lo purgamos
      mem.delete(key);
    }

    // REDIS
    const rHitRaw = await redisGet(key); // ya viene "limpio" por redisGet
    if (rHitRaw) {
      const rHit = unwrapMaybeWrapped(rHitRaw) || rHitRaw;
      if (debug) (rHit.meta ??= {}).cache = "redis";
      mem.set(key, { at: now, value: rHit });
      return new Response(JSON.stringify(rHit), { headers: corsHeaders(origin) });
    }
  }

  try {
    // Smokes
    type ProdSmoke = { products: { nodes: Array<{ id: string; handle: string }> } };
    type OrdSmoke = { orders: { nodes: Array<{ id: string }> } };
    await adminGQLWithTimeout<ProdSmoke>(`query { products(first:1){ nodes { id handle } } }`, undefined, 10000);
    await adminGQLWithTimeout<OrdSmoke>(`query { orders(first:1){ nodes { id } } }`, undefined, 10000);

    // Query real
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

    do {
      const data = await adminGQLWithTimeout<OrdersPage>(ORDERS_QUERY, { cursor }, 15000);
      const { nodes, pageInfo } = data.orders;
      for (const o of nodes) {
        for (const li of o.lineItems.nodes) {
          const p = li.product;
          if (!p) continue;
          if (!passSegments({ tags: p.tags, productType: p.productType }, segments)) continue;
          qtyByProductId.set(p.id, (qtyByProductId.get(p.id) || 0) + li.quantity);
        }
      }
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);

    if (!qtyByProductId.size) {
      mem.set(key, { at: now, value: resp });
      await redisSet(key, resp, MEM_TTL);
      if (debug) (resp.meta ??= {}).source = "live-empty";
      return new Response(JSON.stringify(resp), { headers: corsHeaders(origin) });
    }

    const topIds = [...qtyByProductId.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);

    const NODES_QUERY = `query N($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle } } }`;
    type NodesResp = { nodes: Array<{ id?: string; handle?: string } | null> };
    const nd = await adminGQLWithTimeout<NodesResp>(NODES_QUERY, { ids: topIds }, 10000);

    resp.handles = (nd.nodes || []).filter(Boolean).map((n) => n!.handle).filter((h): h is string => Boolean(h));
    (resp.meta ??= {}).source = "live";

    mem.set(key, { at: now, value: resp });
    await redisSet(key, resp, MEM_TTL);

    return new Response(JSON.stringify(resp), { headers: corsHeaders(origin) });
  } catch (e: unknown) {
    // stale-if-error desde memoria/redis live
    const staleRaw = mem.get(key)?.value || (await redisGet(key));
    const stale = unwrapMaybeWrapped(staleRaw) || staleRaw || null;
    if (stale) {
      if (debug) (stale.meta ??= {}).stale = true;
      return new Response(JSON.stringify(stale), { headers: corsHeaders(origin) });
    }
    return new Response(JSON.stringify({ handles: [], meta: { error: "live-failed" } }), { headers: corsHeaders(origin) });
  }
}
// 1) Inten
