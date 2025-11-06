import type { LoaderFunctionArgs } from "@remix-run/router";
export async function loader({}: LoaderFunctionArgs) {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
