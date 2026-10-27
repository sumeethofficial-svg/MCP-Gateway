# MCP Portal

**One door to every MCP server your team uses, running on Kubernetes.**

Admins connect MCP servers once. Everyone else gets their tools through a single endpoint and a chat assistant, with their own API key, their own permissions, and an audit trail of every call.

MCP Portal ships with a WooCommerce store, a WooCommerce MCP server, two additional upstreams, a React dashboard, a chat agent that acts as the signed-in user, and a provisioner that spins up isolated stores on demand. The same Helm-based setup runs locally on k3d and on a VPS using k3s.

---

## What you get

| | |
|---|---|
| **One endpoint** | Add `http://<host>/mcp` and your API key to Claude Code, Cursor, or MCP Inspector. Tools from every enabled upstream are available through one endpoint; upstream credentials never reach the client. |
| **Chat assistant** | Ask “What orders came in today?” or “Convert that total to USD.” The assistant calls tools through the gateway **as you**, shows each call, and records it in the audit log under your identity. |
| **Four upstream types** | `woo` (WooCommerce store), `kube-ops` (platform diagnostics), `currency` (currency conversion), and a deliberately malicious test server for the security demo. Additional stores register their own WooCommerce upstreams. |
| **Safe by default** | Hashed and revocable API keys, per-tool permissions, encrypted upstream credentials, quarantine for poisoned tool descriptions and rug pulls, an SSRF guard, and default-deny NetworkPolicies. |
| **Resilient** | Parallel catalog refresh, per-upstream timeouts, circuit breakers, and health monitoring keep a dead or slow upstream from blocking the other servers. The dashboard reports why a server is unreachable. |
| **Multi-store** | Create and delete WooCommerce stores from the dashboard. Each extra store gets its own namespace, database, credentials, storage, quota, and WooCommerce MCP server. |
| **Same chart everywhere** | `values-local.yaml` for k3d and `values-prod.yaml` for a k3s VPS. Helm supports repeatable upgrades and rollbacks. |

## Architecture

![System design](docs/img/architecture.png)

Only the Ingress is public. MCP servers use internal Kubernetes Services and are restricted by default-deny NetworkPolicies. The gateway is the control point for authentication, policy checks, routing, timeouts, audit logging, and chat tool execution.

The default store runs in the `store` namespace. Gateway state and platform upstreams live in `platform`. Each additional store is installed in a separate `store-<id>` namespace by the provisioner.

More detail: [`docs/DESIGN.md`](docs/DESIGN.md).

## Live demo

| | |
|---|---|
| **Dashboard** | http://mcp.3.26.73.226.sslip.io |
| **Store** | http://shop.3.26.73.226.sslip.io |
| **Store admin** | http://shop.3.26.73.226.sslip.io/wp-admin |

The demo runs on a k3s server over plain HTTP (no TLS), so use `http://`, not `https://`. Login details are below 

| | |
|---|---|
| **Dashboard admin** | `admin@example.com` / the password from the command below |
| **Dashboard member** | email and password from `.demo/credentials.txt` |
| **WordPress admin** | `shopadmin` / the password from the command below |
 
Get the passwords on the server (bash):
 
```bash
# dashboard admin
kubectl -n platform get secret gateway-secrets -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d; echo
# WordPress admin
kubectl -n store get secret wordpress-admin -o jsonpath='{.data.password}' | base64 -d; echo
```
 
If you created the demo member on the VPS, the `.demo/credentials.txt` on the machine where you ran `node scripts/demo-users.mjs` holds its password and API key. If you only ran it locally, create the member again against the VPS:
 
```bash
BASE=http://mcp.3.26.73.226.sslip.io ADMIN_PASSWORD=<admin password> node scripts/demo-users.mjs
```

---

## Quick start (local, about 10 minutes)

**Needs:** Docker Desktop with the Linux container engine running, [k3d](https://k3d.io), `kubectl`, Helm 3.14+, Node.js 22+, and ports 80/443 available. The commands below are written to work in a Windows PowerShell workflow; GNU Make is optional. If you have Make installed, the equivalent shortcuts are also shown.

Run commands from the repository root. First create `values-secret.yaml` (example below) and add it to `.gitignore`. Then build the Docker images, import them into k3d, and install the Helm chart.

### 1. Configure the LLM key

Create `values-secret.yaml` in the repository root:

```yaml
platform:
  gateway:
    llm:
      apiKey: "<your-provider-api-key>"
      baseUrl: "<OpenAI-compatible-endpoint>"
      model: "<model-supported-by-your-provider>"
```

The endpoint, model, and API key must belong to the same provider. Never commit this file or share it publicly.

### 2. Create the k3d cluster

```bash
k3d cluster create --config deploy/k3d.yaml
```

### 3. Build all seven Docker images

Build all seven images from PowerShell or another terminal with Docker available. These are the exact commands defined in the root `Makefile`; run them from the repository root:

```bash
docker build -f docker/node.Dockerfile --build-arg WORKSPACE=apps/gateway --build-arg ENTRY=dist/main.js -t mcp-portal-gateway:dev .
docker build -f docker/dashboard.Dockerfile -t mcp-portal-dashboard:dev .
docker build -f docker/node.Dockerfile --build-arg WORKSPACE=mcp-servers/woo-mcp -t mcp-portal-woo-mcp:dev .
docker build -f docker/node.Dockerfile --build-arg WORKSPACE=mcp-servers/kube-ops-mcp -t mcp-portal-kube-ops-mcp:dev .
docker build -f docker/node.Dockerfile --build-arg WORKSPACE=mcp-servers/currency-mcp -t mcp-portal-currency-mcp:dev .
docker build -f docker/node.Dockerfile --build-arg WORKSPACE=mcp-servers/evil-mcp -t mcp-portal-evil-mcp:dev .
docker build -f docker/provisioner.Dockerfile -t mcp-portal-provisioner:dev .
```

### 4. Import the images into k3d

No registry is needed for local development. Import the images into the `mcp-portal` cluster with:

```bash
k3d image import mcp-portal-gateway:dev mcp-portal-dashboard:dev mcp-portal-woo-mcp:dev mcp-portal-kube-ops-mcp:dev mcp-portal-currency-mcp:dev mcp-portal-evil-mcp:dev mcp-portal-provisioner:dev -c mcp-portal
```

### 5. Install or upgrade with Helm

```bash
helm upgrade --install mcp-portal charts/mcp-portal \
  -f charts/mcp-portal/values-local.yaml \
  -f values-secret.yaml \
  --set image.tag=dev \
  --namespace default --wait --wait-for-jobs --timeout 20m
```

### 6. Create demo users and verify the deployment

```bash
node scripts/demo-users.mjs
kubectl get pods -n platform
kubectl get pods -n store
kubectl get ingress -A
```

The demo-user script writes generated credentials to `.demo/credentials.txt`. Keep that file private and do not commit it.

**Optional Makefile shortcut:** if GNU Make is installed, `make up TAG=dev` creates the cluster if needed, builds and imports images, and installs the chart. Run `make demo` afterward. The shortcut does not include `values-secret.yaml`, so use the explicit Helm command above when configuring the LLM.

| Open | Purpose |
|---|---|
| http://mcp-portal.localtest.me | Dashboard and MCP endpoint |
| http://shop.localtest.me | WooCommerce storefront |
| http://shop.localtest.me/wp-admin | WordPress admin |

If `localtest.me` does not resolve in your environment, add this line to your hosts file:

```text
127.0.0.1 mcp-portal.localtest.me shop.localtest.me
```

Full VPS setup, image publishing, upgrades, and troubleshooting: [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md).

## Try it

1. **Place an order.** Open the storefront, add a product to the cart, and check out with *Cash on delivery* if enabled. The order will appear in WooCommerce and can be queried through the gateway.
2. **Ask the assistant.** Sign in to the dashboard as an admin and open **Chat**. Try “List the products in my store” or “What orders came in today?” To demonstrate a write tool, ask “Create a product called Demo Mug priced 499,” then verify it in WooCommerce.
3. **Connect an external client as a member.** Use **Connect a client** in the dashboard, or run:

   ```powershell
   claude mcp add --transport http mcp-portal http://mcp-portal.localtest.me/mcp --header "Authorization: Bearer <member-api-key>"
   ```

   List the tools, ask the same orders question, then try a request that uses two upstreams, such as “Get today's orders and convert the total to USD.”
4. **Test permissions.** Revoke the member's API key and confirm the next request is rejected. Disable an upstream and check that its tools disappear from the available tool list.
5. **Test failure isolation.** Remove or scale down one upstream pod and confirm the other upstreams keep working while the dashboard identifies the unavailable server.
6. **Read the audit log.** Check that tool calls and rejected attempts are attributed to the correct user.
7. **Demonstrate tool quarantine.** In **Servers → Add server**, add the deliberately malicious test server. Inspect the scanner's reasons and confirm the flagged tool remains quarantined until an admin approves it.
8. **Create another store.** Use **Stores → Create store**. Once it is ready, verify that its WooCommerce tools are registered and cannot be used by another member who does not own that store.

See [`docs/DEMO.md`](docs/DEMO.md) for the end-to-end demonstration script.

## Connect an external MCP client

MCP Portal exposes a Streamable HTTP endpoint. Use the API key created for the specific user; do not use an upstream WooCommerce or platform credential.

| Setting | Local | Production |
|---|---|---|
| Endpoint | `http://mcp-portal.localtest.me/mcp` | `https://mcp-portal.example.com/mcp` |
| Transport | Streamable HTTP | Streamable HTTP |
| Authentication | `Authorization: Bearer <user-api-key>` | `Authorization: Bearer <user-api-key>` |

For example, Claude Code can be configured with:

```bash
claude mcp add --transport http mcp-portal \
  http://mcp-portal.localtest.me/mcp \
  --header "Authorization: Bearer <member-api-key>"
```

The gateway names tools using `<server>__<tool>` (for example, `woo__list_products`, `kube-ops__list_pods`, or `currency__convert_currency`). Extra stores use their own server identifiers. This prevents collisions when upstreams expose the same tool name.

For large tool catalogues, the gateway also exposes the lazy endpoint at `/mcp/lazy`. It provides meta-tools for searching the available tools, inspecting a tool schema, and invoking a tool without loading the entire catalogue into the model context. Calls through lazy mode still pass through the same authorization and audit path.

**Security:** API keys are secrets. Do not paste them into public issues, screenshots, source code, or chat transcripts. Revoke an exposed key from the dashboard and create a new one.

## Deploy to a VPS

The same Helm chart runs on k3s. The repository's reference deployment uses a Linux VPS; the documented baseline is approximately 2 vCPU and 4 GB RAM for the platform and one store. Multi-store demos need more memory.

1. Prepare a Linux VPS and install k3s.
2. Configure DNS to point your MCP Portal and storefront hostnames at the VPS, or use the documented `sslip.io` HTTP-only demo option.
3. Build and publish versioned container images to a registry the VPS can access.
4. Create a private override file named `my-values.yaml` in the repository root. Replace the example hostnames, registry, email, and provider settings with your own values:

```yaml
# my-values.yaml — do not commit this file
ingress: {host: mcp.example.com, shopHost: shop.example.com, scheme: https, tls: {enabled: true}}
image: {registry: ghcr.io/YOUR-USER, tag: "1.0.0"}
platform:
  gateway:
    cookieSecure: true
    bootstrapAdmin: {email: you@example.com}
    llm:
      apiKey: "<your-provider-api-key>"
      baseUrl: "<OpenAI-compatible-endpoint>"
      model: "<provider-model>"
  stores: {baseDomain: stores.example.com}
```

The LLM key, endpoint, and model must match the same provider. Keep `my-values.yaml` out of Git. For an HTTP-only `sslip.io` demo, use the HTTP settings documented in [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md) instead of the HTTPS values above.

5. Deploy the production chart and private override:

```bash
helm upgrade --install mcp-portal charts/mcp-portal \
  -f charts/mcp-portal/values-prod.yaml \
  -f my-values.yaml \
  --namespace default --wait --wait-for-jobs --timeout 20m

helm history mcp-portal
helm rollback mcp-portal <revision> --wait
```

For a real deployment, use TLS and secure session cookies, keep credentials out of Git, restrict access to `/wp-admin` and `/wp-login.php`, back up database volumes and encryption Secrets, and verify that NetworkPolicies are enforced by the cluster network plugin. The `sslip.io` HTTP-only mode is for a demo, not for customer data.

Detailed VPS instructions, DNS/TLS setup, image publishing, upgrades, rollbacks, backups, and troubleshooting: [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md).

---

## What is where

| Path | Contents |
|---|---|
| `apps/gateway` | MCP gateway, authentication, authorization, upstream routing/health, audit log, and chat agent |
| `apps/dashboard` | React dashboard for servers, tools, stores, team, API keys, audit, chat, and client connection details |
| `apps/provisioner` | Creates and deletes isolated WooCommerce stores |
| `mcp-servers/woo-mcp` | WooCommerce products, orders, order status, and sales tools via the WooCommerce REST API |
| `mcp-servers/kube-ops-mcp` | Scoped Kubernetes diagnostics; administrative restart/scale actions are restricted |
| `mcp-servers/currency-mcp` | Currency lookup/conversion tools |
| `mcp-servers/evil-mcp` | Deliberately malicious fixture for tool-description poisoning and rug-pull demonstrations |
| `packages/mcp-kit` | Shared MCP server utilities |
| `charts/mcp-portal` | Platform and default store Helm chart, including local and production values |
| `charts/mcp-store` | Helm chart installed for each additional store |
| `scripts/` | Demo account creation, chart rendering, and isolation checks |
| `docs/` | System design, threat model, deployment guide, demo notes, and feature inventory |

## Documents

| Document | Contents |
|---|---|
| [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md) | Local and VPS setup, image publishing, upgrade, rollback, backups, observability, and troubleshooting |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Architecture choices, request flow, failure handling, authorization, and design tradeoffs |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Shared credentials, client-token boundaries, malicious upstreams, team isolation, Kubernetes boundaries, and known gaps |
| [`docs/MULTI-STORE.md`](docs/MULTI-STORE.md) | Store provisioning, lifecycle, recovery, quotas, and isolation |
| [`docs/DEMO.md`](docs/DEMO.md) | End-to-end demo walkthrough |
| [`docs/STAND-OUTS.md`](docs/STAND-OUTS.md) | Core requirements, bonus features, stand-outs, source locations, and items not implemented |

## System design and tradeoffs

The full architecture rationale, request flow, failure handling, and tradeoff analysis are maintained in [`docs/DESIGN.md`](docs/DESIGN.md). Key points:

- **One policy path:** dashboard actions, external MCP calls, and chat-agent calls share the gateway authorization and audit path.
- **Aggregated namespaced tools:** upstream tools are combined into one catalogue and named `<server>__<tool>` to avoid collisions.
- **Failure isolation:** parallel discovery, per-upstream timeouts, health checks, and circuit breakers limit the impact of a failing upstream.
- **Separate state stores:** PostgreSQL holds platform users, keys, permissions, configuration, and audit data; WooCommerce data remains in MySQL.
- **Explicit tradeoffs:** in-memory rate limits are per replica; audit records are not tamper-evident; each store has one WordPress replica; heuristic scanning cannot prove a tool is safe; external MCP OAuth/SSO is not implemented.

For production changes, use the chart profiles and deployment guidance in [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md). Replace local hostnames with real DNS, enable TLS and secure cookies, choose suitable persistent storage, keep secrets outside Git, publish versioned images, and verify NetworkPolicy enforcement and backup/restore procedures.

## Threat model

The detailed threat model and known gaps are maintained in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). The core boundaries are:

- **Shared upstream credentials:** credentials are encrypted at rest and used server-side; members can invoke them only through tools their permissions allow. A permitted write tool can still change shared store data.
- **Client-token separation:** the user's MCP Portal API key authenticates only to the gateway. It is not forwarded to upstream servers; the gateway attaches each upstream's own credential after authorization.
- **Malicious tool descriptions and results:** `evil-mcp` demonstrates prompt-injection-style descriptions. The scanner and hash-based change detection can quarantine suspicious changes, but they are heuristics—not proof of safety.
- **Team boundaries:** keys, audit rows, conversations, and store access are scoped by user/role/ownership. Shared write permissions can still affect shared resources, and audit storage is not tamper-evident.
- **Kubernetes and operational gaps:** NetworkPolicies must be enforced by the cluster CNI; `kube-ops-mcp` is scoped and cannot read Secrets; the provisioner needs tightly constrained privileges. Other documented gaps include per-replica rate limits, no confirmation step for chat write actions, and LLM-provider visibility into prompts/results.

## Verify the claims

Run the test and deployment checks from the repository root:

```powershell
npm test
node scripts/render-charts.mjs
bash scripts/verify-isolation.sh
bash scripts/verify-stores.sh
```

`npm test` needs PostgreSQL configured and running for integration tests. `render-charts.mjs` checks rendered chart configuration. The two isolation scripts should be run against a live cluster; `verify-stores.sh` requires at least two extra stores to have been created. These checks exercise specific properties; they are not a complete security audit.

## Bonus and stand-out items

The detailed list and source paths are maintained in [`docs/STAND-OUTS.md`](docs/STAND-OUTS.md). Stand-outs include:

- **Multi-store provisioning:** `apps/provisioner/`, `charts/mcp-store/`, and `docs/MULTI-STORE.md`.
- **Tool-level allow/deny rules:** `apps/gateway/src/policy/engine.ts`.
- **Poisoned tool quarantine and rug-pull detection:** `mcp-servers/evil-mcp/` and `apps/gateway/src/upstreams/`.
- **Kubernetes self-diagnostics with admin-only restart/scale:** `mcp-servers/kube-ops-mcp/`.
- **Lazy search-then-call mode:** `/mcp/lazy` in `apps/gateway/src/mcp/server.ts`.
- **Metrics and health status:** `apps/gateway/src/metrics.ts` and `upstreams/health.ts`.
- **Chart and isolation verification:** `scripts/render-charts.mjs`, `scripts/verify-isolation.sh`, and `scripts/verify-stores.sh`.
- **VPS deployment, upgrade, and rollback instructions:** `docs/DEPLOY-VPS.md`.

Not implemented, as noted in `docs/STAND-OUTS.md`: SSO/OAuth for MCP clients, per-user upstream credentials, and a dedicated Kubernetes operator/CRD for store provisioning.
