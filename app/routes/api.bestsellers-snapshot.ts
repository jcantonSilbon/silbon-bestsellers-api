import type { LoaderFunctionArgs } from "react-router";

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

// normalizado tokens
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
  if (genderTag) return segments.has(genderTag.replace("gender:", "") as Segment);

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

  const wantsMan = segments.has("man");
  const wantsWoman = segments.has("woman");

  if (wantsMan && !wantsWoman) return okMan && !okWoman;
  if (wantsWoman && !wantsMan) return okWoman && !okMan;
  if (wantsMan && wantsWoman && (okMan || okWoman)) return true;
  if (segments.has("teens") && okTeens) return true;
  if (segments.has("kids") && okKids) return true;

  return false;
}

/* ======================== R E D I S ======================== */
type Resp = { handles: string[]; meta?: Record<string, unknown> };

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisSet(key: string, value: Resp, ttlSec?: number) {
  if (!R_URL || !R_TOKEN) return;
  const body: any = { value: JSON.stringify(value) };
  if (ttlSec && ttlSec > 0) body.EX = ttlSec;

  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Claves snapshot
const CACHE_VER = "v5";
function snapKey(segs: Set<Segment>, limit: number) {
  return `bestsellers:${CACHE_VER}:snapshot:last30:${[...segs].sort().join(",")}:${limit}`;
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
  const url = new URL(request.url);

  // ✅ protección
  const secret = url.searchParams.get("secret") || "";
  if (!process.env.SNAPSHOT_SECRET || secret !== process.env.SNAPSHOT_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // params
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "60", 10), 60);
  const segments = parseSegments(url);

  // last30 fijo
  const toISO = endOfDayUTC(new Date()).toISOString();
  const fromISO = startOfDayUTC(new Date(Date.now() - 30 * 24 * 3600 * 1000)).toISOString();

  const resp: Resp = {
    handles: [],
    meta: { source: "snapshot", range: { from: fromISO, to: toISO }, segments: [...segments] },
  };

  try {
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

    const topIds = [...qtyByProductId.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    if (topIds.length) {
      const NODES_QUERY = `query N($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle } } }`;
      type NodesResp = { nodes: Array<{ id?: string; handle?: string } | null> };

      const nd = await adminGQLWithTimeout<NodesResp>(NODES_QUERY, { ids: topIds }, 10000);

      resp.handles = (nd.nodes || [])
        .filter(Boolean)
        .map((n) => n!.handle)
        .filter((h): h is string => Boolean(h));
    }

    // ✅ guardar snapshot (13h)
    const key = snapKey(segments, limit);
    await redisSet(key, resp, 60 * 60 * 13);

    return new Response(JSON.stringify({ ok: true, key, count: resp.handles.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "snapshot-failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
