# MCP Portal: staged MySQL + HMT catalog deployment

This patch stages MySQL 8.4 alongside the existing MariaDB. It does **not** copy old data to MySQL: WordPress is pointed at a fresh `wordpress` database on MySQL, so the setup hook initializes a fresh demo storefront. The old MariaDB StatefulSet and its `data-mariadb-0` PVC are intentionally retained for rollback/reference.

## What changed

- Adds `store.mysql` values, `mysql-credentials`, and a MySQL 8.4 StatefulSet/Service with its own PVC.
- Switches WordPress and the setup Job to the new `mysql` service.
- Adds NetworkPolicy rules for MySQL while retaining MariaDB policy rules.
- Seeds four idempotent WooCommerce demo products: HMT Pilot, HMT Sona, HMT Kohinoor, HMT Janata. Prices are illustrative demo prices in INR; descriptions explicitly do not claim authenticity.
- Restores the legacy `app.kubernetes.io/part-of: storegate` selector label for chart workloads. This is an internal compatibility label: the chart/release/store branding remains MCP Portal. It avoids changing immutable selectors on the existing StatefulSets and Deployments during this upgrade.

## Deploy from Windows PowerShell

1. Extract this patch ZIP into the root of your existing project folder, allowing files to overwrite:
   `D:\MACHINE LEARNING\MCP for woo commerce`

2. Open PowerShell and run:

   ```powershell
   cd "D:\MACHINE LEARNING\MCP for woo commerce"
   .\scripts\deploy-mysql-hmt.ps1
   ```

3. The script checks that the active Kubernetes context is `k3d-storegate`, saves a local inventory of the release history and PVCs, runs `helm lint`, and then asks you to type `DEPLOY` before making changes.

4. After it completes, verify:
   - `mysql-0` is Ready in namespace `store`.
   - `wordpress` is Ready.
   - `mysql` and `wordpress` Services have endpoints.
   - The setup Job logs show all four HMT products created or updated.
   - `http://shop.localtest.me` opens and displays the HMT catalog.

## Important safety notes

- The script does not delete the old MariaDB StatefulSet or PVC.
- Do not run `helm upgrade --force`, `helm uninstall`, `make down`, or delete PVCs as a workaround.
- If the upgrade fails, stop and inspect `helm history storegate -n default`, `kubectl -n store get pods,pvc,svc,endpoints`, and the failing pod/Job logs. Do not delete the old database.
- The MySQL database is fresh. This is intentional for the demo store; existing WooCommerce data is not migrated.
- This script cannot reach your local cluster from ChatGPT. You must run it on the Windows machine where `kubectl` and `helm` are configured.
