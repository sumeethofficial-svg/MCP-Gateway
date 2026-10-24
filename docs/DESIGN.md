# System design and tradeoffs

## What problem this solves

A small team wants to run a WooCommerce store from AI clients and chat, without handing every person the store's credentials, without wiring each client to each tool server one by one, and with a record of who did what. The system is therefore three things: a **store**, **MCP servers** that expose it (and other tools), and a **gateway** that is the only door.

## Shape of the system

```
client ──Bearer API key──▶ gateway ──Bearer token──▶ upstream MCP servers ──▶ real systems
browser ──session cookie─▶ gateway   (credentials live here, never leave)
chat agent ───in-process, as the user───▲
```

* **Everything a person can do goes through one code path**: `GatewayService.callTool(principal, name, args)`. External MCP clients, the chat agent, and the dashboard's tool view all use it, so permissions, rate limits, quarantine, timeouts and auditing cannot be bypassed by choosing a different front door.
* **The gateway is both an MCP client and an MCP server.** As a client it talks Streamable HTTP to upstreams. As a server it builds a fresh `Server` per request with the caller baked in, so a handler can never act for the wrong person.

## Key decisions and why

### 1. Stateless Streamable HTTP everywhere

No MCP sessions, no server-side stream state. Each POST is self-contained (`sessionIdGenerator: undefined`, JSON responses). Consequences: any replica can answer any request, a restart loses nothing, rolling updates are trivial, and a load balancer needs no stickiness. The cost is giving up server-initiated notifications and long-lived streams, which nothing here needs (tool lists change rarely and clients re-list).

### 2. WooCommerce access via the REST API with a scoped key

Options considered:

| | REST API | WP-CLI exec | Direct SQL |
|---|---|---|---|
| Versioned, supported | yes | partly | no (schema is internal, HPOS vs posts) |
| Least privilege | a key bound to a `shop_manager` user | needs exec into the WordPress pod | needs DB credentials |
| Network shape | plain HTTP to a Service | needs `pods/exec` RBAC | opens the database to another workload |
| Business rules (stock, emails, order-status hooks) | applied | applied | **skipped**, so it silently corrupts state |

REST wins on every axis that matters for a long-lived integration. The one wrinkle is that WooCommerce only accepts key/secret Basic auth over HTTPS; inside the cluster we speak HTTP, so woo-mcp sends `X-Forwarded-Proto: https` and `wp-config.php` honours it (the same mechanism a TLS-terminating ingress uses). The client calls `/wp-json/wc/v3/...` rather than `/?rest_route=`: against a live store the `rest_route` form is routed but WooCommerce's Basic-auth handler ignores the key there (401), so the setup Job enables pretty permalinks and the client relies on them.

The key belongs to a dedicated `mcp-portal-mcp` user with the `shop_manager` role, not an administrator, so a leaked key cannot install plugins or read other users' passwords.

### 3. Tool naming: `<server>__<tool>`

Two upstreams may both export `search`. The gateway prefixes every tool with its server's slug (`fx__search`, `tickets__search`), truncates to the 64-character client limit with a hash suffix, and de-duplicates. Routing parses the slug and goes **only** to that server, so a dead sibling never delays a call.

### 4. Failure isolation

* Catalog refresh is parallel and per-server with its own timeout; a slow server contributes nothing instead of stalling the list.
* Each upstream has a circuit breaker (3 failures → open for a cooldown) so a dead server fails in microseconds, not after the timeout, and a stale-if-error grace window keeps its last-known tools visible (marked unreachable).
* A health monitor probes continuously, so the dashboard status is current and clients rarely pay for a cold refresh.
* Tool calls have their own deadline. A hung upstream returns a clear "timeout" error to the caller; it never hangs the gateway.

### 5. Authorization

Two roles (admin, member) are the baseline, and **rules** refine them: `(role | user) × (server | *) × (tool | *) → allow | deny`. The most specific rule wins, deny wins ties. The secure default for members is *read-only tools from servers the operator trusts*, so a new write tool or a new server is invisible to members until an admin opts in. Denied tools are hidden from the list **and** refused on call (defence in depth), and policy is evaluated on every request from the database, so a change applies on the next call.

### 6. API keys and sessions

Keys are `sgk_` + 256 random bits; only a SHA-256 is stored (fast hashing is appropriate for high-entropy secrets, unlike passwords, which use scrypt). Authentication hits the database on every request with no cache, which is what makes revocation immediate: the cost is one indexed lookup per request. Dashboard sessions are opaque random tokens in an `httpOnly`, `SameSite=Lax` cookie, backed by a table; state-changing requests also require a custom header and a matching `Origin`.

### 7. The chat agent is just another MCP client

It connects to the gateway **in-process** (`InMemoryTransport`) as the signed-in user's principal. There is no second code path to keep consistent, and no privileged service account that could be tricked into acting for someone else. Tool output is wrapped as untrusted data in the system prompt, results are size-capped, steps are limited, and the client disconnecting aborts the run (and the in-flight tool call).

### 8. Upstream credentials

Encrypted at rest with AES-256-GCM (key id prefix, so keys can be rotated: set the new key, keep the old as `ENCRYPTION_KEY_PREVIOUS`, re-save). Decrypted only inside the process at call time. No API returns them; the admin view reports only `hasCredential`.

### 9. One Helm chart, two namespaces

The assignment's two halves (store, platform) live in separate namespaces so NetworkPolicy can say "only gateway pods in `platform` may reach woo-mcp in `store`". They ship as **one release** because the woo-mcp bearer token must be identical in both namespaces; a single render guarantees that, and one `helm upgrade` / `helm rollback` covers the whole system. The price is less reuse of the store half on its own (a multi-store setup would want the store templates factored into a subchart; the namespace names are already parameters for exactly that reason).

Secrets are generated once with `randAlphaNum` and then **kept** by reading them back with `lookup`, so an upgrade never rotates a database password out from under a volume. They carry `helm.sh/resource-policy: keep`, matching the PVCs that survive uninstall.

### 10. Gateway-level tool search ("lazy mode")

With dozens of tools, listing them all costs context on every turn. `/mcp/lazy` exposes `search_tools`, `describe_tool`, `call_tool`. Calls through it go through the same permission and audit path, and the chat agent switches to it automatically above a threshold.

## Tradeoffs I made on purpose

| Choice | Benefit | Cost / what I'd revisit |
|---|---|---|
| Postgres for gateway state | transactions, audit queries, one real dependency | one more stateful pod; fine at this scale |
| In-memory rate limits and login throttle | no extra infrastructure | per replica, so N replicas allow N× the limit; use Redis or a Postgres counter if that matters |
| Audit in the same database | simple, queryable, transactional with changes | not tamper-evident; ship rows to an append-only sink for stronger guarantees |
| Single WordPress replica (RWO volume) | simple, correct | no HA for the storefront; needs RWX storage or object storage for media to scale |
| REST over WP-CLI/SQL | supported, least-privilege | an extra HTTP hop and WooCommerce's REST quirks |
| Operator-vetted tier for Helm-declared servers | no false quarantine on first-party servers | the operator takes responsibility for those; admin-added servers are always scanned |
| Heuristic poisoning scanner | catches the common attacks, with reasons shown | heuristics are bypassable; the real controls are quarantine on change, no auto-trust, and least-privilege defaults |
| Not implementing OAuth for MCP clients | API keys are what the assignment asks for and work in every client | per-user OAuth would give short-lived tokens and SSO |

## What I would do next

Multi-store (one `woo-mcp` per store, `namespaces.store` and `store.name` are already parameters); per-tool confirmation prompts for write tools in chat; Redis-backed rate limits; OpenTelemetry traces across gateway and upstreams; SSO.

## What the first live run found

The automated suite uses real Postgres and real upstreams, but a mocked WooCommerce and no cluster. Running the whole thing on k3d found problems only a real stack shows:

| Found by | Problem | Fix |
|---|---|---|
| WooCommerce setup Job hung | The Job ran `wp` against `wp-config.php`, which reads the DB host and password from environment variables the Job did not have | Same four `WORDPRESS_DB_*` variables on the Job; bounded waits that print the error instead of hanging |
| Re-install failed | Secrets were read back from the cluster (already `cs_`-prefixed) and prefixed again, overflowing WooCommerce's 43-character column | Strip the prefix before re-adding it |
| woo-mcp got 401 with a valid key | WooCommerce's Basic-auth handler ignores the key on `/?rest_route=` URLs but accepts `/wp-json/`; the mock had accepted both | Client uses `/wp-json/`; the mock now rejects the other form too |
| Audit page showed `{}` for every call | The page read `args`, the API sends `argsPreview` | Fixed, plus an API regression test |
| Gateway restarted 3 times on first install | It waited 30 s for Postgres, whose image takes longer to pull on a cold node | Waits up to 3 minutes; startup probe window widened |
| Chat failed on the first rate limit | No retry | Up to three tries honouring `Retry-After` (capped at 15 s) |
| Chat rejected by an OpenAI reasoning model | Chat Completions only allows tools with reasoning off | Optional `reasoningEffort` setting |
| A member could create products after an admin saved a rule | The form's tool box defaulted to `*` and read as a placeholder, so an allow-all rule was saved | The form now spells out the effect in plain words and asks for confirmation on broad allow rules |

The permission engine itself behaved correctly in the last case: the rule granted exactly what it said. The fix is in the interface, not the policy.
