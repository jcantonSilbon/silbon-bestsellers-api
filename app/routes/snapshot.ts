import type { LoaderFunctionArgs } from "react-router";

// Reutilizamos helpers del otro archivo (puedes moverlos a un utils común si prefieres)
type Segment = "man" | "woman" | "teens" | "kids";
type Resp = { handles: string[]; meta?: Record<string, unknown> };

const R_URL = process.env.UPSTASH_REDIS_REST_URL!;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const SNAPSHOT_SECRET = process.env.SNAPSHOT_SECRET!;
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CACHE_VER = "v5";

function snapKey(segs: Set<Segment>, limit: number) {
  return `bestsellers:${CACHE_VER}:snapshot:last30:${[...segs].sort().join(",")}:${limit}`;
}
function startOfDayUTC(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function endOfDayUTC(d: Date)   { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23,59,59,999)); }
function tokenSet(hay: string | string[]): Set<string> {
  const arr = Array.isArray(hay) ? hay : [hay]; const out = new Set<string>();
  for (const v of arr) for (const t of (v||"").toLowerCase().split(/[^a-z0-9:]+/).filter(Boolean)) out.add(t);
  return out;
}
function hasAnyToken(hay: Set<string>, needles: readonly string[]) {
  for (const n of needles) if (hay.has(n.toLowerCase())) return true;
  return false;
}
function passSegments(p: { tags?: string[]; productType?: string }, segments: Set<Segment>) {
  if (!segments.size) return true;
  const genderTag = (p.tags || []).map((t) => t.toLowerCase().trim()).find((t) => t.startsWith("gender:"));
  if (genderTag) return segments.has(genderTag.replace("gender:", "") as Segment);
  const tagsTokens = tokenSet(p.tags || []), ptTokens = tokenSet(p.productType || "");
  const TOK = {
    man: ["gender:man","gender:men","man","men","caballero","mens","hombre","hombres"] as const,
    woman: ["gender:woman","woman","women","mujer","mujeres","dama","womens","ladies","fem"] as const,
    teens: ["segment:teens","teen","teens","juvenil","adolesc"] as const,
    kids: ["segment:kids","kid","kids","niño","nino","niña","nina","infantil","children","child"] as const,
  };
  const okMan = hasAnyToken(tagsTokens, TOK.man) || hasAnyToken(ptTokens, TOK.man);
  const okWoman = hasAnyToken(tagsTokens, TOK.woman) || hasAnyToken(ptTokens, TOK.woman);
  const okTeens = hasAnyToken(tagsTokens, TOK.teens) || hasAnyToken(ptTokens, TOK.teens);
  const okKids  = hasAnyToken(tagsTokens, TOK.kids)  || hasAnyToken(ptTokens, TOK.kids);
  const wantsMan = segments.has("man"), wantsWoman = segments.has("woman");
  if (wantsMan && !wantsWoman) return okMan && !okWoman;
  if (wantsWoman && !wantsMan) return okWoman && !okMan;
  if (wantsMan && wantsWoman && (okMan || okWoman)) return true;
  if (segments.has("teens") && okTeens) return true;
  if (segments.has("kids") && okKids) return true;
  return false;
}

async function gql<T>(query: string, variables?: any, signal?: AbortSignal): Promise<T> {
  const url = `https://${SHOP}/admin/api/2024-10/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const j = await r.json();
  if (!r.ok || j.errors?.length) throw new Error("Shopify GraphQL error");
  return j.data as T;
}
async function redisSet(key: string, value: Resp) {
  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) }) // snapshot sin expiración (hasta el próximo lunes)
  }).catch(() => {});
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  if (!SNAPSHOT_SECRET || secret !== SNAPSHOT_SECRET) {
    return new Response(JSON.stringify({ ok:false, error:"unauthorized" }), { status: 401 });
  }

  // Config por query o defaults
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 100);
  const segmentsList: Segment[] = ["man","woman","kids","teens"];

  // Últimos 30 días (normalizado)
  const toISO = endOfDayUTC(new Date()).toISOString();
  const fromISO = startOfDayUTC(new Date(Date.now() - 30*24*3600*1000)).toISOString();

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
  const allLineItems: Array<{ quantity:number; product:{ id:string; handle:string; tags?:string[]; productType?:string } }> = [];
  let cursor: string | null = null;
  do {
    const data = await gql<OrdersPage>(ORDERS_QUERY, { cursor });
    const { nodes, pageInfo } = data.orders;
    for (const o of nodes) for (const li of o.lineItems.nodes) if (li.product) allLineItems.push({ quantity: li.quantity, product: li.product! });
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  // 2) Para cada conjunto de segmentos, agrega y guarda snapshot
  for (const segs of segmentsList.map((s) => new Set<Segment>([s]))) {
    const qtyByProductId = new Map<string, number>();
    for (const li of allLineItems) {
      const p = li.product;
      if (!passSegments({ tags: p.tags, productType: p.productType }, segs)) continue;
      qtyByProductId.set(p.id, (qtyByProductId.get(p.id) || 0) + li.quantity);
    }
    if (!qtyByProductId.size) {
      await redisSet(snapKey(segs, limit), { handles: [], meta: { snapshot_at: new Date().toISOString(), range:{ from: fromISO, to: toISO }, segments:[...segs] } });
      continue;
    }

    // top N
    const topIds = [...qtyByProductId.entries()].sort((a,b)=>b[1]-a[1]).slice(0, limit).map(([id])=>id);
    const NODES_QUERY = `query N($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle } } }`;
    type NodesResp = { nodes: Array<{ id?:string; handle?:string }|null> };
    const nd = await gql<NodesResp>(NODES_QUERY, { ids: topIds });

    const handles = (nd.nodes||[]).filter(Boolean).map(n => n!.handle).filter(Boolean) as string[];
    const payload: Resp = {
      handles,
      meta: { snapshot_at: new Date().toISOString(), range:{ from: fromISO, to: toISO }, segments:[...segs], source:"snapshot" }
    };
    await redisSet(snapKey(segs, limit), payload);
  }

  return new Response(JSON.stringify({ ok:true, snapshot_at:new Date().toISOString(), range:{ from: fromISO, to: toISO }, limit }), { status: 200 });
}
