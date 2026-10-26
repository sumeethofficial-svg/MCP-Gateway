# What is implemented: core, bonus and stand-outs

A checklist against the assignment: what is built, where it lives, and how to see it working. Setup is in [`DEPLOY-VPS.md`](DEPLOY-VPS.md).

## Core requirements

| Requirement | What is implemented | Where / how to see it |
|---|---|---|
| **Store on Kubernetes** | WordPress + WooCommerce (pinned) with MySQL 8.4, on persistent volumes. A setup Job installs WooCommerce, seeds demo products, and creates a least-privilege `shop_manager` user and REST key | `charts/mcp-portal/templates/store/`; storefront at `shop.localtest.me` |
| **WooCommerce MCP server** | Streamable HTTP over the WooCommerce REST API: `list_products`, `get_product`, `create_product`, `remove_product`, `list_orders`, `get_order`, `update_order_status`, `sales_summary`. No customer notes; customer details only when a call asks. Reachable only from the gateway | `mcp-servers/woo-mcp` |
| **Gateway** | One MCP endpoint (`/mcp`) over every enabled server. Tools are named `<server>__<tool>`, so collisions cannot happen. Timeouts, circuit breakers, a health monitor and parallel catalog refresh keep a dead upstream from affecting the rest. Upstream credentials are encrypted and never leave the server | `apps/gateway` |
| **Three or more upstreams** | `woo` (store), `kube-ops` (platform diagnostics), `currency` (rates, convert, historical), plus a malicious test server for the threat-model demo | `mcp-servers/` |
| **Dashboard** | Servers with status and tools, add/edit/disable/remove, API keys, team and invites, audit log, chat, connect-a-client, stores | `apps/dashboard` |
| **Roles and keys** | Admin and member. One API key per user, stored hashed, revocation takes effect on the next request | `apps/gateway/src/auth` |
| **Audit log** | Every tool call: user, server, tool, time, duration, outcome. Rejected calls too, against the key's owner | dashboard → Audit log |
| **Chat agent** | An LLM tool loop that calls tools through the gateway as the signed-in user and shows which tools it called | `apps/gateway/src/agent`; dashboard → Chat |
| **Helm, local and prod** | One chart with `values-local.yaml` and `values-prod.yaml`. Probes, requests and limits on every workload; Secrets for all credentials; PVCs; Ingress for storefront and dashboard | `charts/mcp-portal` |

## Bonus: multi-store provisioning

Create and delete stores from the dashboard. Each store gets its own namespace, MySQL, WordPress, Secrets, volumes, Ingress host and woo-mcp, registered in the gateway automatically (`woo-<id>__…`). ResourceQuota and LimitRange per store, caps per user and in total, a provisioning timeout, safe retries, recovery after a provisioner restart, clean teardown. A store's tools are usable only by its owner and admins. Details: [`MULTI-STORE.md`](MULTI-STORE.md). Proof: `make verify-stores`. Code: `apps/provisioner`, `charts/mcp-store`.

## Stand-outs

| Item | What it is | Where |
|---|---|---|
| **VPS on k3s** | The same chart on an AWS EC2 k3s server, sslip.io hostnames (or a real domain with cert-manager TLS), documented diff against local | [`DEPLOY-VPS.md`](DEPLOY-VPS.md), `charts/mcp-portal/values-prod.yaml` |
| **Upgrade and rollback** | Zero-downtime gateway rollouts, additive migrations, kept secrets, a rehearsed `helm rollback`, backups | [`DEPLOY-VPS.md`](DEPLOY-VPS.md) |
| **Tool-level permissions** | Allow/deny rules by role or person × server × tool; restricted tools are hidden from the list and rejected if called directly; changes apply on the next request | `apps/gateway/src/policy/engine.ts`; dashboard → Servers → Permissions |
| **Security hardening** | SSRF guard, encrypted credentials with rotation, hashed keys, tool-poisoning quarantine and rug-pull detection, CSRF defences, login throttling, default-deny NetworkPolicies, non-root read-only containers, Pod Security levels, least-privilege RBAC | [`THREAT_MODEL.md`](THREAT_MODEL.md); `apps/gateway/src/upstreams/`; `charts/mcp-portal/templates/` |
| **Platform debugs itself** | The kube-ops upstream lets the assistant diagnose pods, events and logs; restart and scale are admin-only | `mcp-servers/kube-ops-mcp` |
| **Observability** | Prometheus metrics, structured logs with request ids, the reason an upstream is unreachable shown in the dashboard | `apps/gateway/src/metrics.ts`, `upstreams/health.ts` |
| **Search-then-call mode** | `/mcp/lazy` with three meta tools to keep model context small; the chat switches automatically | `apps/gateway/src/mcp/server.ts` |
| **Self-checking chart** | A renderer and linter that fails on missing probes, limits or hardening, broken wiring, or a leaked demo password | `scripts/render-charts.mjs` |
| **Threat-model fixture** | A malicious test upstream (Service `malicious-test`, source `mcp-servers/evil-mcp`) with a poisoned description and a later rug pull, to demonstrate the defences | `mcp-servers/evil-mcp` |

## Not done

SSO or OAuth for MCP clients, per-user upstream credentials, an operator/CRD for stores (the provisioner uses Helm).

## Origin

Started from the open-source storegate project, credited in the README. [Add your own specifics here: which parts you wrote or changed.]