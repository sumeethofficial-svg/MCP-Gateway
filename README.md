# MCP Portal

**One door to every MCP server your team uses, running on Kubernetes.**
Admins connect MCP servers once. Everyone else gets all of them through a single endpoint and a chat assistant, with their own key, their own permissions, and an audit trail of every call.

It ships with a WooCommerce store, a WooCommerce MCP server, two more upstreams, a React dashboard, a chat agent that acts as the signed-in user, and a provisioner that spins up isolated stores on demand. One Helm chart runs it on a laptop (k3d) and on a VPS (k3s).


---

## What you get

| | |
|---|---|
| **One endpoint** | Add `http://<host>/mcp` and your API key to Claude Code, Cursor or MCP Inspector and see the tools of every enabled server. Nothing else to configure, and no upstream credential ever reaches you |
| **Chat assistant** | Ask "What orders came in today?" or "Convert that total to USD". The assistant calls tools through the gateway **as you**, shows each call, and every call lands in the audit log under your name |
| **Four upstreams** | `woo` (store), `kube-ops` (the platform diagnoses itself), `currency` (rates), and a deliberately malicious test server for the security demo |
| **Safe by default** | Hashed, instantly revocable keys. Per-tool permissions. Quarantine for poisoned tool descriptions and rug pulls. SSRF guard. Default-deny network policies |
| **Resilient** | A dead or slow upstream never breaks listing or calls to the others, and the dashboard says why it is down |
| **Multi-store** | Create and delete full WooCommerce stores from the dashboard, each in its own namespace with its own database, quota and tools |
| **Same chart everywhere** | `values-local.yaml` for k3d, `values-prod.yaml` for a k3s VPS. Upgrades and rollbacks are `helm upgrade` and `helm rollback` |

## Architecture

![System design](docs/img/architecture.png)

Only the Ingress is public. Every MCP server is ClusterIP and reachable only from the gateway, enforced by default-deny NetworkPolicies. Details: [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Quick start (local, about 10 minutes)

**Needs:** Docker Desktop, [k3d](https://k3d.io), kubectl, Helm 3.14+, Node 22. Ports 80 and 443 free.

```powershell
k3d cluster create --config deploy/k3d.yaml
# build the 7 images and import them (full commands in docs/DEPLOY-VPS.md)
k3d image import mcp-portal-gateway:dev mcp-portal-dashboard:dev mcp-portal-woo-mcp:dev mcp-portal-kube-ops-mcp:dev mcp-portal-currency-mcp:dev mcp-portal-evil-mcp:dev mcp-portal-provisioner:dev -c mcp-portal
helm upgrade --install mcp-portal charts/mcp-portal -f charts/mcp-portal/values-local.yaml -f values-secret.yaml --set image.tag=dev --namespace default --wait --wait-for-jobs --timeout 20m
node scripts/demo-users.mjs      # creates an admin and a member with API keys → .demo/credentials.txt
```

`values-secret.yaml` holds your LLM settings and stays out of git:
```yaml
platform:
  gateway:
    llm: {apiKey: "<key>", baseUrl: "<OpenAI-compatible endpoint>", model: "<model>"}
```

| Open | |
|---|---|
| http://mcp-portal.localtest.me | Dashboard and MCP endpoint |
| http://shop.localtest.me | Storefront |
| http://shop.localtest.me/wp-admin | WordPress admin |

Full step-by-step, with every command: [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md).

## Try it

1. **Place an order.** Storefront → add a product → check out with *Cash on delivery*. It shows up in WordPress admin.
2. **Ask the assistant.** Dashboard (as admin) → *Chat*: "Create a product called Demo Mug priced 499", then "What orders came in today?".
3. **Connect a client as the member.** Dashboard → *Connect a client*, or:
   ```powershell
   claude mcp add --transport http mcp-portal http://mcp-portal.localtest.me/mcp --header "Authorization: Bearer <member key>"
   ```
   List the tools, ask the same orders question, then try one prompt that needs two servers ("get today's orders and convert the total to USD").
4. **Take control.** Revoke the member's key and watch the next call fail. Disable a server and watch its tools vanish. Delete an upstream's pod and watch the others keep working while the dashboard shows the reason.
5. **Read the audit log.** Every call above is there, attributed to the right person.
6. **Break it on purpose.** *Servers → Add server* with the malicious test server and see its poisoned tool quarantined with the reasons.
7. **Make another store.** *Stores → Create store*, then ask the chat to compare orders across stores.

## Deploy to a VPS

Same chart, `values-prod.yaml`, on k3s (the reference deployment is one AWS EC2 instance). No domain needed: `sslip.io` hostnames work out of the box, and a real domain gets TLS through cert-manager.

```bash
curl -sfL https://get.k3s.io | sh -
helm upgrade --install mcp-portal charts/mcp-portal -f charts/mcp-portal/values-prod.yaml -f my-values.yaml --namespace default --wait --wait-for-jobs --timeout 20m
helm history mcp-portal
helm rollback mcp-portal <revision> --wait
```

What changes between local and VPS (hostnames, TLS, replicas, secrets, storage), backups and troubleshooting: [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md).

---

## What is where

| Path | Contents |
|---|---|
| `apps/gateway` | MCP gateway, auth, permissions, audit, chat agent |
| `apps/dashboard` | React dashboard |
| `apps/provisioner` | Creates and deletes isolated stores |
| `mcp-servers/` | `woo-mcp`, `kube-ops-mcp`, `currency-mcp`, and the malicious test server (`evil-mcp`) |
| `charts/mcp-portal`, `charts/mcp-store` | The Helm charts: platform plus default store, and one extra store |
| `scripts/` | Demo users, isolation checks, chart renderer and linter |
| `docs/` | Everything below |

## Documents

| | |
|---|---|
| [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md) | Setup, local and VPS, upgrade, rollback, backups, troubleshooting |
| [`docs/STAND-OUTS.md`](docs/STAND-OUTS.md) | Everything implemented: core, bonus and stand-outs, with where to find each |
| [`docs/DESIGN.md`](docs/DESIGN.md) | System design and tradeoffs |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Threat model |
| [`docs/MULTI-STORE.md`](docs/MULTI-STORE.md) | Store provisioning: lifecycle, recovery, isolation |
| [`docs/DEMO.md`](docs/DEMO.md) | Script for the demo video |

## Verify the claims

```powershell
npm test                          # unit and integration tests (needs Postgres)
node scripts/render-charts.mjs    # renders every chart profile and fails on missing probes, limits, hardening
bash scripts/verify-isolation.sh  # against a live cluster: network isolation, public surface, no leaked credentials
bash scripts/verify-stores.sh     # store-to-store isolation (create two stores first)
```

## Credits

Started from the open-source [storegate](https://github.com/ManiMaran2011/storegate) project. `<one or two sentences on what you built or changed>`