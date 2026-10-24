#!/usr/bin/env node
/**
 * Creates the two demo users the assignment asks for (an admin and a member), gives each an API key and writes
 * everything needed to try the system to .demo/credentials.txt. Safe to re-run.
 *
 *   node scripts/demo-users.mjs                      # against the local k3d cluster
 *   BASE=https://mcp-portal.example.com ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/demo-users.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://mcp-portal.localtest.me").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
const MEMBER = { email: "sid@example.com", name: "Sid (member)", password: process.env.MEMBER_PASSWORD ?? "sid-demo-password-1" };

function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const b64 = execFileSync("kubectl", ["-n", "platform", "get", "secret", "gateway-secrets", "-o", "jsonpath={.data.BOOTSTRAP_ADMIN_PASSWORD}"], { encoding: "utf8" });
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    throw new Error("Could not read the admin password from the cluster. Set ADMIN_PASSWORD (and BASE) explicitly.");
  }
}

async function call(method, path, { cookie, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-requested-with": "mcp-portal", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  return { status: res.status, json, cookie: res.headers.getSetCookie?.()[0]?.split(";")[0] };
}
const must = (r, what) => {
  if (r.status >= 400) throw new Error(`${what} failed (${r.status}): ${r.json?.error?.message ?? "no details"}`);
  return r;
};

const adminPw = adminPassword();
const admin = must(await call("POST", "/api/auth/login", { body: { email: ADMIN_EMAIL, password: adminPw } }), "admin sign-in");

let member = await call("POST", "/api/auth/login", { body: { email: MEMBER.email, password: MEMBER.password } });
if (member.status !== 200) {
  const invite = must(await call("POST", "/api/invites", { cookie: admin.cookie, body: { email: MEMBER.email, role: "member" } }), "invite");
  const token = new URL(invite.json.inviteUrl).searchParams.get("token");
  member = must(await call("POST", "/api/invites/accept", { body: { token, name: MEMBER.name, password: MEMBER.password } }), "accept invite");
  console.log(`created member ${MEMBER.email}`);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const adminKey = must(await call("POST", "/api/keys", { cookie: admin.cookie, body: { name: `demo-admin-${stamp}`, expiresInDays: 30 } }), "admin key").json.plaintext;
const memberKey = must(await call("POST", "/api/keys", { cookie: member.cookie, body: { name: `demo-member-${stamp}`, expiresInDays: 30 } }), "member key").json.plaintext;

const out = `mcp-portal demo credentials (local only; do not reuse)
=====================================================
Dashboard : ${BASE}
Storefront: ${BASE.replace("mcp-portal.", "shop.")}

Admin   ${ADMIN_EMAIL}  /  ${adminPw}
Member  ${MEMBER.email}  /  ${MEMBER.password}

API keys (shown once; mint more under "API keys" in the dashboard)
  admin : ${adminKey}
  member: ${memberKey}

MCP endpoint: ${BASE}/mcp   (lazy search-then-call mode: ${BASE}/mcp/lazy)

Try it with Claude Code:
  claude mcp add --transport http mcp-portal-admin  ${BASE}/mcp --header "Authorization: Bearer ${adminKey}"
  claude mcp add --transport http mcp-portal-member ${BASE}/mcp --header "Authorization: Bearer ${memberKey}"

Or with the MCP Inspector:
  npx @modelcontextprotocol/inspector   (Streamable HTTP, URL above, header Authorization: Bearer <key>)

What you should see:
  * admin  : every tool, including woo/create_product and woo/update_order_status
  * member : read-only tools only (list/get/search); write tools are hidden and refused until an admin allows them
  * both   : every call appears in the audit log under the right person
`;
mkdirSync(".demo", { recursive: true });
writeFileSync(".demo/credentials.txt", out, { mode: 0o600 });
console.log(out);
console.log("Saved to .demo/credentials.txt");
