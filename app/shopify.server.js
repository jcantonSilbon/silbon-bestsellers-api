// app/shopify.server.js
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";

const REQUIRED = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"];
const missing = REQUIRED.filter((k) => !process.env[k]);
const hasEnv = missing.length === 0;

let shopifyDefault = null;
export const apiVersion = ApiVersion.October25;

export let addDocumentResponseHeaders;
export let authenticate;
export let unauthenticated;
export let login;
export let registerWebhooks;
export let sessionStorage;

if (hasEnv) {
  // ⚠️ Importes “pesados” SOLO si hay envs → evita crasheos y evita exigir prisma en modo API-only
  const { PrismaSessionStorage } = await import(
    "@shopify/shopify-app-session-storage-prisma"
  );
  const { default: prisma } = await import("./db.server.js").catch(() =>
    import("./db.server") // por si el bundler resuelve sin extensión
  );

  const shopify = shopifyApp({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
    apiVersion: ApiVersion.October25,
    scopes: process.env.SCOPES?.split(","),
    appUrl: process.env.SHOPIFY_APP_URL || "",
    authPathPrefix: "/auth",
    sessionStorage: new PrismaSessionStorage(prisma),
    distribution: AppDistribution.AppStore,
    ...(process.env.SHOP_CUSTOM_DOMAIN
      ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
      : {}),
  });

  shopifyDefault = shopify;
  addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
  authenticate = shopify.authenticate;
  unauthenticated = shopify.unauthenticated;
  login = shopify.login;
  registerWebhooks = shopify.registerWebhooks;
  sessionStorage = shopify.sessionStorage;
} else {
  // ---- Modo “API-only” (sin Shopify app). Exportamos shims que no rompan el server.
  console.warn(
    "[shopify] Skipping shopifyApp init (missing envs):",
    missing.join(", ")
  );

  const notConfigured = () => {
    throw new Response("Shopify app is not configured", { status: 501 });
  };

  addDocumentResponseHeaders = () => ({});
  authenticate = { admin: notConfigured, public: notConfigured, appProxy: notConfigured };
  unauthenticated = { admin: notConfigured, public: notConfigured, appProxy: notConfigured };
  login = notConfigured;
  registerWebhooks = async () => {};
  sessionStorage = { ready: Promise.resolve() };
}

export default shopifyDefault;
