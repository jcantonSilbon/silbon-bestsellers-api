import type { LoaderFunctionArgs } from "react-router";

/* --- COPIA/PEGA de tu archivo actual: adminGQL, adminGQLWithTimeout, parseSegments,
       passSegments, redisSet, snapKey, startOfDayUTC, endOfDayUTC, types Resp, Segment, etc. --- */

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  // ✅ seguridad
  const secret = url.searchParams.get("secret") || "";
  if (!process.env.SNAPSHOT_SECRET || secret !== process.env.SNAPSHOT_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "60", 10), 60);
  const segments = parseSegments(url);

  // rango fijo last 30 days
  const toISO = endOfDayUTC(new Date()).toISOString();
  const fromISO = startOfDayUTC(new Date(Date.now() - 30 * 24 * 3600 * 1000)).toISOString();

  const resp: Resp = { handles: [], meta: { source: "snapshot", range: { from: fromISO, to: toISO }, segments: [...segments] } };

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

    // ✅ guarda snapshot (13h de TTL, suficiente para 2 ejecuciones/día)
    const sKey = snapKey(segments, limit);
    await redisSet(sKey, resp, 60 * 60 * 13);

    return new Response(JSON.stringify({ ok: true, key: sKey, count: resp.handles.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "snapshot-failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
