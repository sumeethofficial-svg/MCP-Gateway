/**
 * Local development stack without Kubernetes: starts the sample upstreams (a mock WooCommerce,
 * kube-ops over an in-memory cluster, currency and the deliberately
 * malicious evil-mcp) on loopback, then the gateway.
 *   DATABASE_URL=postgres://... npx tsx scripts/dev-stack.mts
 * Sign in with admin@example.com / admin-password-123.
 */
import { createMcpHttpServer } from "@mcp-portal/mcp-kit";
import { registerEvilTools } from "@mcp-portal/evil-mcp/tools";
import { registerKubeOpsTools, WriteGuard } from "@mcp-portal/kube-ops-mcp/tools";
import { createFakeCluster } from "@mcp-portal/kube-ops-mcp/testing";
import { registerCurrencyTools } from "@mcp-portal/currency-mcp/tools";
import { WooClient } from "@mcp-portal/woo-mcp/client";
import { MOCK_KEY, MOCK_SECRET, startMockWoo } from "@mcp-portal/woo-mcp/testing";
import { registerWooTools } from "@mcp-portal/woo-mcp/tools";
import { randomBytes } from "node:crypto";
import { pino } from "pino";

const log = pino({ level: "warn" });
const token = "dev-upstream-token";
const start = (name: string, port: number, register: Parameters<typeof createMcpHttpServer>[0]["registerTools"]) =>
  new Promise<void>((r) => createMcpHttpServer({ name, version: "dev", authToken: token, logger: log, registerTools: register }).listen(port, "127.0.0.1", r));

const woo = await startMockWoo();
const client = new WooClient({ baseUrl: woo.url, consumerKey: MOCK_KEY, consumerSecret: MOCK_SECRET, timeoutMs: 3000 });
await start("woo", 9101, (s) => registerWooTools(s, client, { timezone: "Asia/Kolkata", storeName: "Dev Store" }, log));
// kube-ops over an in-memory cluster that has a crash-looping currency-mcp, so the demo works without Kubernetes.
// Same allowlist shape as the chart: currency-mcp may be restarted/scaled, everything else is read-only.
const cluster = createFakeCluster();
const guard = new WriteGuard(0);
const kubeConfig = { namespaces: ["platform", "store"], writeTargets: [{ namespace: "platform", name: "currency-mcp", maxReplicas: 3 }], minReplicas: 0, maxLogLines: 200, writeCooldownMs: 0 };
await start("kube-ops", 9102, (s) => registerKubeOpsTools(s, { api: cluster, config: kubeConfig, guard }));
await start("currency", 9103, registerCurrencyTools);
await start("evil", 9104, (s) => registerEvilTools(s, { rugPullAfterSeconds: 0, startedAt: Date.now() }));

const up = (slug: string, name: string, port: number, trust: boolean) => ({ slug, name, url: `http://127.0.0.1:${port}/mcp`, credentialEnv: "DEV_UPSTREAM_TOKEN", trustAnnotations: trust, enabled: true });
Object.assign(process.env, {
  PORT: "8080",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/mcp-portal_dev",
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString("base64"),
  BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
  BOOTSTRAP_ADMIN_PASSWORD: "admin-password-123",
  UPSTREAM_ALLOW_LOOPBACK: "true",
  COOKIE_SECURE: "false",
  PUBLIC_URL: "http://localhost:5173",
  DEV_UPSTREAM_TOKEN: token,
  LOG_LEVEL: "info",
  SEEDED_UPSTREAMS: JSON.stringify([up("woo", "WooCommerce store", 9101, true), up("kube-ops", "Cluster operations", 9102, true), up("currency", "Currency rates", 9103, true)].concat([]) /* evil-mcp is on :9104; add it from the dashboard to see quarantine in action */),
});
await import("../apps/gateway/src/main.js");
