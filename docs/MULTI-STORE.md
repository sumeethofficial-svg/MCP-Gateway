# Multi-store provisioning

Anyone signed in to the dashboard can create their own WooCommerce store. Each store is a separate, isolated copy of the store half of the platform, and the chat assistant and MCP clients can use it with no manual steps.

```
Dashboard ──► Gateway ──► Provisioner ──► Kubernetes API
 (Stores)      │  ▲          │  runs `helm upgrade --install` of charts/mcp-store
               │  └─ sync ───┘  (one namespace + one Helm release per store)
               ▼
        woo-<id>__list_products …  (each store's own woo-mcp, registered automatically)
```

## What one store is

`charts/mcp-store` renders, into a namespace `store-<id>`:

| | |
|---|---|
| Workloads | MySQL (StatefulSet), WordPress + WooCommerce (Deployment), the WooCommerce setup Job, this store's own `woo-mcp` |
| Storage | one PVC for MySQL, one for WordPress. They are **not** kept on uninstall: deleting the store deletes the data |
| Secrets | MySQL passwords, WordPress admin password, WooCommerce REST key, woo-mcp bearer token. All generated per store, never shared |
| Ingress | `<id>.<stores.baseDomain>` (local: `<id>.stores.localtest.me`, no DNS work) |
| Guardrails | `ResourceQuota` and `LimitRange` (a store can never use more than 1 CPU / 2 Gi requested, 3 PVCs, 10 pods), Pod Security `baseline`, default-deny `NetworkPolicy` |

## The lifecycle

1. **Create.** The dashboard sends `{name, id}`; the gateway adds the signed-in user as owner and calls the provisioner. The provisioner checks the limits (default 3 stores per user, 8 in total; 2 and 4 in `values-local.yaml`), creates the namespace (labelled and annotated, see *State* below), binds itself to the `mcp-store-admin` role **inside that namespace only**, and starts `helm upgrade --install --wait --wait-for-jobs`.
2. **Provisioning → Ready.** When Helm returns, the provisioner checks WordPress, woo-mcp and the setup Job and marks the namespace `Ready`. The dashboard polls and shows status, URL and elapsed time.
3. **Registration.** The gateway's sync loop (every 15 s and right after create/delete) sees a Ready store, reads its in-cluster address and token from the provisioner, vets the address like any admin-supplied URL, and registers a server named `woo-<id>`. Its tools appear as `woo-<id>__list_products`, `woo-<id>__create_product`, and so on. Two stores never share a tool name.
4. **Delete.** The dashboard asks the provisioner to delete. The gateway removes the store's server immediately; the provisioner stops any running install, runs `helm uninstall`, then deletes the namespace, which removes volumes, Secrets, Ingress and everything else. If `helm uninstall` fails the namespace is deleted anyway.

## State without a database

The provisioner has no database. A store *is* its namespace: the id, owner and Pod Security level are labels; name, phase (`Provisioning`, `Ready`, `Failed`, `Deleting`), reason and timestamps are annotations. That is what makes recovery simple: there is nothing to get out of sync, and `kubectl get ns -l mcp-portal.io/store=true` is the whole truth.

## Retry and recovery

| Situation | What happens |
|---|---|
| The browser retries a create (timeout, double click, reload) | The dashboard sends the same `id` each time; the same id for the same owner returns the existing store (`created: false`). It can never produce two stores. Another user's id is reported as taken, without revealing whose |
| The provisioner restarts mid-install | On start it lists the store namespaces and looks at each Helm release. Release **deployed** → verify the store and mark it Ready. **None** (namespace made, install never started) → start the install. **Pending** (helm was killed mid-install) or **failed** → the store is marked `Failed` with a plain reason ("Provisioning was interrupted … delete it and create it again"). So a store always ends up Ready or Failed, never stuck in Provisioning |
| An install takes too long | After `provisionTimeoutSeconds` (default 20 minutes, counted from the *creation* time, not from the last restart) the install is cancelled and the store is marked `Failed: Timed out …`. Helm is given only the time that is left |
| A delete during an install | The install is cancelled first, then the teardown runs |
| The provisioner is unreachable | The dashboard shows "temporarily unavailable". The gateway's sync changes nothing, so stores keep working and keep their tools |

## Isolation and limits

* **Network.** Each store namespace starts from deny-all. The only cross-namespace rules are: the Ingress controller → WordPress, the gateway → that store's woo-mcp, and DNS. Rules inside a store select only pods of that store. A store's pod has no allowed path to another store's pods, to the platform database, or to the Kubernetes API.
* **Credentials.** Every store has its own database passwords, WordPress admin password, REST key and woo-mcp token. The gateway keeps each store's token encrypted, per server. Store A's token is refused by store B.
* **Who can use a store's tools.** Only its owner and admins. Everyone else cannot list or call them, and a member does not even see that the store exists in the server list. This is checked before any permission rule, so a broad "allow members" rule cannot open one user's shop to another. The owner can use all of their store's tools (they own it); admins can use every store's.
* **Limits.** Per store: `ResourceQuota` + `LimitRange`. Per user and in total: `maxPerUser` and `maxTotal`. Per create: a gateway rate limit (10 per 10 minutes per user). Per install: the timeout above.
* **The provisioner is the most privileged new component, so it is boxed in.** It runs as its own ServiceAccount. Cluster-wide it can only create/get/list/patch/delete **namespaces** and create/get **RoleBindings**; everything else it does it does through a RoleBinding to `mcp-store-admin` inside one store namespace. Two `ValidatingAdmissionPolicy` objects bound the cluster-wide parts: it may only create namespaces named `store-*` that carry the store label and a baseline/restricted Pod Security level, may only modify or delete namespaces that already have that label (and cannot change labels), and may only create a RoleBinding in such a namespace, for itself, to `mcp-store-admin`. It cannot read Secrets in `platform` or `kube-system`, cannot create Deployments there, and cannot touch nodes or ClusterRoles. Its API is reachable only from the gateway pods (NetworkPolicy) and requires a bearer token. `make verify-stores` asks the API server to prove each of these.

## Operating it

```bash
make images import                                   # builds and loads mcp-portal-provisioner too
helm upgrade --install mcp-portal charts/mcp-portal -f charts/mcp-portal/values-local.yaml --set image.tag=dev --namespace default --wait --wait-for-jobs --timeout 20m
# sign in to the dashboard → Stores → Create store; wait for Ready (a few minutes)
kubectl get ns -l mcp-portal.io/store=true           # the stores
kubectl -n store-<id> get pods,pvc,ingress,resourcequota
make verify-stores                                   # needs two Ready stores
```

Turn it off with `--set platform.stores.enabled=false`; the dashboard then says it is not enabled and nothing else changes. Needs Kubernetes 1.30+ (the admission policy API). Do not set `platform.stores.admissionPolicy.enabled=false` in production.

## Decisions and tradeoffs

| Choice | Why | Cost |
|---|---|---|
| Helm in a provisioner pod (not an operator/CRD) | The platform is already Helm; `helm upgrade --install` is idempotent, which is what makes retry and restart recovery simple. Reviewers read the same charts | A `helm` binary and a wide-ish RBAC role in one pod, hence the admission policies. A real operator with a CRD would model status better and reconcile continuously |
| State on the Namespace | No database, nothing to drift | Annotations are not queryable; fine for tens of stores |
| Store chart baked into the provisioner image | The chart version running is the one that was reviewed and tested together with the provisioner | Changing the store chart means rebuilding that image |
| Stores' woo-mcp registered by a sync loop, not by the provisioner calling the gateway | Provisioner stays unaware of the gateway; the gateway recovers by itself after either restarts | Up to one sync interval of delay (kicked immediately after create/delete) |
| Owner can call all of their own store's tools, including writes | A member who creates a shop should be able to run it | Differs from the default for shared servers (members read-only). An explicit *deny* rule still applies |
| Quota is fixed per store, not per user plan | Simple, predictable | No tiers |

## What is and is not verified

Automated: 26 provisioner tests (create, limits, idempotency, timeout, restart recovery, deletion races, failure reasons, the HTTP API), 26 gateway tests (registration, ownership, rotation, SSRF refusal, withdrawal, the API), and `node scripts/render-charts.mjs`, which renders the platform chart for every profile **and** a store, and fails on cluster-wide RBAC outside the three named roles, a missing admission policy, a store object without the store label, a kept PVC or Secret, a cross-namespace NetworkPolicy selector, or a missing quota.

Needs a real cluster (not exercised by the automated tests): the actual Helm install of a store, the admission policies' CEL, NetworkPolicy enforcement, and quota rejection. `make verify-stores` checks the security-relevant ones against a live cluster.

## Known limits

* Store creation takes several minutes (it installs WordPress and WooCommerce from the internet); the first one is slowest.
* No pause/resume, rename, backup or restore of a single store. Deleting is permanent.
* Resize is not supported: the quota is the cap.
* With several gateway replicas each runs the sync; the work is idempotent, a duplicate registration loses to the unique slug, and the next sync converges.
* Stores share the platform's nodes. Isolation is namespace + NetworkPolicy + quota, not separate machines; for hostile tenants add a stricter runtime class or node pools.

