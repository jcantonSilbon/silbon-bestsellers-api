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

export const apiVersion = ApiVersion.October25;

// Exports re-asignables (sin top-level await)
export let addDocumentResponseHeaders = () => ({});
export let authenticate = {
  admin: () => new Response("Shopify app is not configured", { status: 501 }),
  public: () => new Response("Shopify app is not configured", { status: 501 }),
  appProxy: () => new Response("Shopify app is not configured", { status: 501 }),
};
export let unauthenticated = {
  admin: () => new Response("Shopify app is not configured", { status: 501 }),
  public: () => new Response("Shopify app is not configured", { status: 501 }),
  appProxy: () => new Response("Shopify app is not configured", { status: 501 }),
};
export let login = () =>
  new Response("Shopify app is not configured", { status: 501 });
export let registerWebhooks = async () => {};
export let sessionStorage = { ready: Promise.resolve() };

// default export (rellenado tras init)
let shopifyDefault = null;
export default shopifyDefault;

// Lazy init SIN top-level await
async function initShopify() {
  try {
    if (!hasEnv) {
      console.warn(
        "[shopify] Skipping init (missing envs):",
        missing.join(", ")
      );
      return;
    }

    // Importes perezosos para no cargar Prisma si no hace falta
    const { PrismaSessionStorage } = await import(
      "@shopify/shopify-app-session-storage-prisma"
    );
    const { default: prisma } = await import("./db.server");

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

    // Rellenamos exports
    shopifyDefault = shopify;
    addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
    authenticate = shopify.authenticate;
    unauthenticated = shopify.unauthenticated;
    login = shopify.login;
    registerWebhooks = shopify.registerWebhooks;
    sessionStorage = shopify.sessionStorage;
  } catch (err) {
    console.error("[shopify] init failed:", err);
  }
}

// Disparamos init sin await (no bloquea build ni arranque)
initShopify();
