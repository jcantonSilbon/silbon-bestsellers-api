import type { LoaderFunctionArgs } from "react-router";

/* ===================== T I P O S  &  C O N S T A N T E S ===================== */
type Segment = "man" | "woman" | "teens" | "kids";
type Resp = { handles: string[]; meta?: Record<string, unknown> };

const R_URL = process.env.UPSTASH_REDIS_REST_URL!;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const SNAPSHOT_SECRET = process.env.SNAPSHOT_SECRET!;
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CACHE_VER = "v5";

const SEGMENTS: Segment[] = ["man", "woman", "teens", "kids"];

/** Clave de snapshot: últimos 30 días + conjunto de segmentos + límite */
function snapKey(segs: Set<Segment>, limit: number) {
  // OJO: key estable (segs ordenados, empty set = "")
  return `bestsellers:${CACHE_VER}:snapshot:last30:${[...segs].sort().join(",")}:${limit}`;
}

/* =========================== F E C H A S  U T C =========================== */
function startOfDayUTC(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function endOfDayUTC(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/* ========================= S E G M E N T  M A T C H ========================= */
function tokenSet(hay: string | string[]): Set<string> {
  const arr = Array.isArray(hay) ? hay : [hay];
  const out = new Set<string>();
  for (const v of arr) for (const t of (v || "").toLowerCase().split(/[^a-z0-9:]+/).filter(Boolean)) out.add(t);
  return out;
}
function hasAnyToken(hay: Set<string>, needles: readonly string[]) {
  for (const n of needles) if (hay.has(n.toLowerCase())) return true;
  return false;
}
function passSegments(p: { tags?: string[]; productType?: string }, segments: Set<Segment>) {
  if (!segments.size) return true; // empty set = todos

  // 1) tag explícito gender:* manda
  const genderTag = (p.tags || []).map((t) => t.toLowerCase().trim()).find((t) => t.startsWith("gender:"));
  if (genderTag) return segments.has(genderTag.replace("gender:", "") as Segment);

  // 2) tokens
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

  // Lógica de combinación (man/woman exclusivos; teens/kids independientes)
  const wantsMan = segments.has("man");
  const wantsWoman = segments.has("woman");
  const wantsTeens = segments.has("teens");
  const wantsKids = segments.has("kids");

  let ok = false;
  if (wantsMan && !wantsWoman) ok = okMan && !okWoman;
  else if (wantsWoman && !wantsMan) ok = okWoman && !okMan;
  else if (wantsMan && wantsWoman) ok = okMan || okWoman;

  if (!ok) {
    if (wantsTeens && okTeens) ok = true;
    if (wantsKids && okKids) ok = true;
  }
  return ok;
}

/* ============================ A D M I N  G Q L ============================ */
type GQLError = { message: string; extensions?: Record<string, unknown> };
type GraphQLResponse<T> = { data?: T; errors?: GQLError[] };

async function gql<T>(query: string, variables?: any, signal?: AbortSignal): Promise<T> {
  const url = `https://${SHOP}/admin/api/2024-10/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const j = (await r.json().catch(() => ({}))) as GraphQLResponse<T>;
  if (!r.ok || j.errors?.length) throw new Error("Shopify GraphQL error");
  return (j.data as T) ?? (null as unknown as T);
}

/** Timeout por página para evitar cuelgues */
async function gqlWithTimeout<T>(query: string, variables?: any, ms = 15000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await gql<T>(query, variables, ac.signal);
  } finally {
    clearTimeout(t);
  }
}

/* =============================== R E D I S =============================== */
async function redisSet(key: string, value: Resp) {
  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" },
    // snapshot sin expiración (lo sobreescribe el próximo job)
    body: JSON.stringify({ value: JSON.stringify(value) }),
  }).catch(() => {});
}

/* ========================= C O M B I N A C I O N E S ========================= */
function allCombinations<T>(arr: readonly T[], includeEmpty = true): Array<Set<T>> {
  const n = arr.length;
  const out: Array<Set<T>> = [];
  const start = includeEmpty ? 0 : 1;
  for (let mask = start; mask < (1 << n); mask++) {
    const s = new Set<T>();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s.add(arr[i]);
    out.push(s);
  }
  if (includeEmpty) out.unshift(new Set<T>()); // asegurar empty primero
  return out;
}

/* ================================ L O A D E R ================================ */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  if (!SNAPSHOT_SECRET || secret !== SNAPSHOT_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Config por query o defaults
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 100);

  // Últimos 30 días (normalizado a bordes de día UTC)
  const toISO = endOfDayUTC(new Date()).toISOString();
  const fromISO = startOfDayUTC(new Date(Date.now() - 30 * 24 * 3600 * 1000)).toISOString();

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

  // 1) Descarga una vez todas las órdenes del rango
  const allLineItems: Array<{
    quantity: number;
    product: { id: string; handle: string; tags?: string[]; productType?: string };
  }> = [];

  let cursor: string | null = null;
  do {
    const data = await gqlWithTimeout<OrdersPage>(ORDERS_QUERY, { cursor }, 15000);
    const { nodes, pageInfo } = data.orders;
    for (const o of nodes) {
      for (const li of o.lineItems.nodes) {
        if (li.product) allLineItems.push({ quantity: li.quantity, product: li.product });
      }
    }
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  // Helper para construir y guardar un snapshot para un set de segmentos
  async function buildAndSaveSnapshotFor(segs: Set<Segment>) {
    const qtyByProductId = new Map<string, number>();

    for (const li of allLineItems) {
      const p = li.product;
      if (!passSegments({ tags: p.tags, productType: p.productType }, segs)) continue;
      qtyByProductId.set(p.id, (qtyByProductId.get(p.id) || 0) + li.quantity);
    }

    const key = snapKey(segs, limit);

    if (!qtyByProductId.size) {
      await redisSet(key, {
        handles: [],
        meta: { snapshot_at: new Date().toISOString(), range: { from: fromISO, to: toISO }, segments: [...segs] },
      });
      return;
    }

    const topIds = [...qtyByProductId.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
    const NODES_QUERY = `query N($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle } } }`;
    type NodesResp = { nodes: Array<{ id?: string; handle?: string } | null> };
    const nd = await gqlWithTimeout<NodesResp>(NODES_QUERY, { ids: topIds }, 10000);

    const handles = (nd.nodes || []).filter(Boolean).map((n) => n!.handle).filter(Boolean) as string[];
    const payload: Resp = {
      handles,
      meta: {
        snapshot_at: new Date().toISOString(),
        range: { from: fromISO, to: toISO },
        segments: [...segs],
        source: "snapshot",
      },
    };
    await redisSet(key, payload);
  }

  // 2) Calcula y guarda snapshots para TODAS las combinaciones (incluida empty = "all")
  const combos = allCombinations<Segment>(SEGMENTS, true); // 16 sets (2^4)
  for (const combo of combos) {
    // eslint-disable-next-line no-await-in-loop
    await buildAndSaveSnapshotFor(combo);
  }

  // 3) Respuesta
  return new Response(
    JSON.stringify({
      ok: true,
      snapshot_at: new Date().toISOString(),
      range: { from: fromISO, to: toISO },
      segments: combos.map((s) => [...s].join("+") || "all"),
      limit,
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
