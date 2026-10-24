# Bonus and stand-out items

The brief asks for at least three stand-outs; these are all implemented.

| Item | What it is | Where |
|---|---|---|
| **Tool-level permissions** | Rules by role or person × server × tool, allow/deny, most-specific wins, secure defaults for members, enforced on list **and** call, applied on the next request | `apps/gateway/src/policy/engine.ts`; dashboard *Servers → Permissions* and per-tool selector; tests in `apps/gateway/test/core.test.ts` |
| **Security hardening** | SSRF guard (static + connect-time), encrypted credentials with rotation, hashed revocable keys, tool-poisoning quarantine and rug-pull detection, CSRF defences, login throttling, default-deny NetworkPolicies, non-root read-only containers, no mounted service-account tokens, Pod Security levels | `docs/THREAT_MODEL.md`; `apps/gateway/src/upstreams/{ssrf,scanner,pins}.ts`; `charts/mcp-portal/templates/networkpolicies.yaml`; `make verify` |
| **VPS on k3s** | Same chart, `values-prod.yaml`, TLS via cert-manager, generated secrets, documented diff against local | `docs/DEPLOY-VPS.md`, `charts/mcp-portal/values-prod.yaml` |
| **Upgrade and rollback** | Zero-downtime gateway rollouts, advisory-locked additive migrations, idempotent setup Job, secrets kept across upgrades, `helm rollback` guidance, backups | `docs/DEPLOY-VPS.md` |
| **Observability** | Prometheus metrics, structured logs, and clear *why* an upstream is unreachable in the dashboard | `apps/gateway/src/metrics.ts`, `apps/gateway/src/upstreams/health.ts` |
| **Search-then-call mode** | `/mcp/lazy` with three meta tools to keep model context small; the chat agent switches automatically | `apps/gateway/src/mcp/server.ts` |
| **Self-checking chart** | A renderer and policy linter that fails on missing probes, limits, hardening, broken Secret/Service/Ingress wiring, mismatched tokens or a leaked demo password | `scripts/render-charts.mjs`, `scripts/chart-render/` |
| **A threat-model fixture** | `evil-mcp`, deliberately malicious (poisoned description, later rug pull) for demonstrating the defences | `mcp-servers/evil-mcp` |

Not done, deliberately: multi-store (the chart keeps namespace and store name as parameters so it is a small step), SSO, per-user upstream credentials.
