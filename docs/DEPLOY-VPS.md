# Deploying to a VPS (k3s)

The same chart that runs on your laptop runs here. Only the values differ.

## What changes between local and production

`charts/mcp-portal/values-local.yaml` vs `values-prod.yaml` (everything else is `values.yaml`):

| Setting | Local (k3d) | Production (k3s VPS) | Why |
|---|---|---|---|
| `ingress.host` / `shopHost` | `mcp-portal.localtest.me` / `shop.localtest.me` | your real domains | public DNS |
| `ingress.scheme`, `ingress.tls.enabled` | `http`, off | `https`, on | TLS via cert-manager |
| `ingress.annotations` | none | `cert-manager.io/cluster-issuer` | automatic certificates |
| `platform.gateway.cookieSecure` | `false` | `true` | session cookie only over HTTPS |
| `platform.gateway.replicas` | 1 | 2 (+ PodDisruptionBudget) | survive node maintenance / rollouts |
| Admin and WordPress passwords | fixed demo values | **generated**, kept across upgrades | nothing predictable |
| `platform.evil.enabled` | `true` (for the quarantine demo) | `false` | the fixture is malicious by design |
| Images | `mcp-portal-*:dev`, imported into k3d | `ghcr.io/<you>/mcp-portal-*:<version>` | a registry the VPS can pull from |
| Volumes / limits | small | larger | real data |

## 1. Prepare the server

Any Linux VPS with 2 vCPU / 4 GB RAM is enough. Point two DNS records (A or AAAA) at it: `mcp-portal.<domain>` and `shop.<domain>`.

```bash
curl -sfL https://get.k3s.io | sh -          # includes Traefik and a NetworkPolicy controller
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown $USER ~/.kube/config
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'YAML'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: {name: letsencrypt-prod}
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef: {name: letsencrypt-prod}
    solvers: [{http01: {ingress: {class: traefik}}}]
YAML
```

Open ports 80 and 443 (and 22). Nothing else needs to be reachable.

## 2. Images

Build in CI or locally and push (replace `ghcr.io/you`):

```bash
make images TAG=1.0.0
for i in gateway dashboard woo-mcp fx-mcp tickets-mcp; do
  docker tag mcp-portal-$i:1.0.0 ghcr.io/you/mcp-portal-$i:1.0.0 && docker push ghcr.io/you/mcp-portal-$i:1.0.0
done
```

For a private registry add a pull secret and `--set 'image.pullSecrets[0].name=regcred'`. For a single server with no registry: `docker save` the images and `sudo k3s ctr images import -`, then use `image.registry=""`.

## 3. Install

Keep your environment's choices in one small file next to the repo (never commit the key):

```yaml
# my-values.yaml
ingress: {host: mcp-portal.example.com, shopHost: shop.example.com}
image: {registry: ghcr.io/you, tag: "1.0.0"}
platform:
  gateway:
    bootstrapAdmin: {email: you@example.com}
    llm: {apiKey: "<provider key>"}
```

```bash
helm upgrade --install mcp-portal charts/mcp-portal -f charts/mcp-portal/values-prod.yaml -f my-values.yaml \
  --namespace default --wait --wait-for-jobs --timeout 20m
```

The first install takes a few minutes: the setup Job downloads WooCommerce from wordpress.org. Follow it with `kubectl -n store logs job/wordpress-setup -f`. `helm` prints the commands to read the generated admin passwords.

Then `BASE=https://mcp-portal.example.com ADMIN_PASSWORD=... node scripts/demo-users.mjs` creates the demo admin and member for a recorded demo (skip it for real use and use *Team → Invite* instead).

Hardening to apply before real customers: restrict `/wp-admin` and `/wp-login.php` on the shop host to your IPs (a Traefik `ipAllowList` middleware or a firewall rule), and take a backup (below).

## Upgrades

```bash
git pull && make images TAG=1.1.0   # push as above
# bump image.tag in my-values.yaml, then:
helm upgrade mcp-portal charts/mcp-portal -f charts/mcp-portal/values-prod.yaml -f my-values.yaml \
  --namespace default --wait --wait-for-jobs --timeout 20m
```

* Gateway and dashboard roll with `maxUnavailable: 0`, so there is no gap. Gateway migrations run at start under a Postgres advisory lock, so two replicas starting together are safe. Migrations are additive; destructive changes ship in two releases.
* Passwords and keys are **kept** (read back with `lookup`), so an upgrade never rotates a credential under a live volume.
* The setup Job re-runs after each upgrade and is idempotent: it only changes what drifted (for example, if you bump `store.wordpress.woocommerceVersion`).
* WordPress uses the `Recreate` strategy (single RWO volume), so the storefront has a short blip during its own upgrade; the gateway and dashboard do not.
* A changed LLM key or any gateway setting restarts the gateway automatically (config checksum annotation).

## Rollback

```bash
helm history mcp-portal
helm rollback mcp-portal <revision> --wait --timeout 10m
```

Rollback restores the manifests (images, config). It does **not** undo database changes: WordPress/MariaDB and Postgres data live on volumes and are untouched. For the gateway this is safe because migrations are additive. If a WooCommerce upgrade went wrong, restore the database backup as well.

## Backups

State is two volumes plus the Secrets:

```bash
# MariaDB (store)
kubectl -n store exec sts/mariadb -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --all-databases --single-transaction' > store-$(date +%F).sql
# Gateway (users, keys, audit, servers)
kubectl -n platform exec sts/postgres -- pg_dump -U gateway gateway > gateway-$(date +%F).sql
# Uploads and plugins
kubectl -n store exec deploy/wordpress -- tar czf - -C /var/www/html wp-content > wp-content-$(date +%F).tgz
# Secrets (encryption key!) - store somewhere safe and separate
kubectl -n platform get secret gateway-secrets -o yaml > gateway-secrets.yaml
```

Losing `gateway-secrets` loses the ability to decrypt stored upstream credentials (you could re-enter them, but keep the backup).

## Observability

* Gateway `/metrics` (cluster-internal only): `gateway_tool_calls_total{server,tool,outcome,via}`, `gateway_tool_call_duration_seconds`, `gateway_upstream_up{server}`, `gateway_auth_failures_total{reason}`, `gateway_chat_runs_total`.
* Structured JSON logs; each request line carries a request id that also appears on the audit row. `Authorization` and cookie headers are redacted.
* The dashboard shows live upstream status, **why** a server is unreachable, and latency.

## Troubleshooting

| Symptom | Look at |
|---|---|
| `helm install` times out | `make status`; `kubectl -n store describe pod -l app.kubernetes.io/name=wordpress` (image pull? volume?) |
| Setup Job fails | `kubectl -n store logs job/wordpress-setup`. Usually outbound access to wordpress.org (check `networkPolicy.internetEgress` and your firewall). The Job is safe to re-run: `helm upgrade ...` again |
| WordPress pod crash-loops with permission errors | The pod needs `CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, NET_BIND_SERVICE`; check your cluster's Pod Security or admission policy isn't stricter than `baseline` for the `store` namespace |
| woo tools say "authentication failed" | The REST key row was not written: re-run the setup Job and read its log |
| Server shows *Unreachable* | The dashboard shows the reason (DNS, refused, timeout, 401, rejected URL). For in-cluster hosts check `UPSTREAM_PRIVATE_ALLOWLIST` and the NetworkPolicy |
| Chat says "not configured" | `platform.gateway.llm.apiKey` is empty |
| Cannot reach `*.localtest.me` | Your resolver blocks rebinding to 127.0.0.1: add the two hosts to your hosts file |
