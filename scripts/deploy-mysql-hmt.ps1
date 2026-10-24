[CmdletBinding()]
param(
  [string]$Release = "storegate",
  [string]$ReleaseNamespace = "default",
  [string]$StoreNamespace = "store",
  [string]$ChartDir = ".\charts\mcp-portal",
  [string]$ValuesFile = ".\charts\mcp-portal\values-local.yaml"
)

$ErrorActionPreference = "Stop"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found. Install/configure it, then rerun."
  }
}

Require-Command "kubectl"
Require-Command "helm"

$context = (& kubectl config current-context).Trim()
Write-Host "Kubernetes context: $context" -ForegroundColor Cyan
if ($context -ne "k3d-storegate") {
  throw "Safety stop: expected context 'k3d-storegate', found '$context'. Switch to the intended cluster before running."
}

$releaseLine = & helm list -n $ReleaseNamespace --filter "^$Release$" --short
if ($LASTEXITCODE -ne 0 -or -not $releaseLine) {
  throw "Helm release '$Release' was not found in namespace '$ReleaseNamespace'. No changes made."
}
if (-not (Test-Path $ChartDir)) { throw "Chart folder not found: $ChartDir" }
if (-not (Test-Path $ValuesFile)) { throw "Values file not found: $ValuesFile" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path ".\backups" "before-mysql-hmt-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

Write-Host "`nSaving release history and PVC inventory to $backupDir" -ForegroundColor Cyan
& helm history $Release -n $ReleaseNamespace | Out-File (Join-Path $backupDir "helm-history.txt") -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Could not save Helm history." }
& kubectl get pvc -A -o wide | Out-File (Join-Path $backupDir "pvc-before.txt") -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Could not save PVC inventory." }
& kubectl -n $StoreNamespace get pods,svc,endpoints,statefulset,deployment -o wide |
  Out-File (Join-Path $backupDir "store-before.txt") -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Could not save store inventory." }

Write-Host "`nValidating chart..." -ForegroundColor Cyan
& helm lint $ChartDir -f $ValuesFile
if ($LASTEXITCODE -ne 0) { throw "helm lint failed. No deployment attempted." }

Write-Host "`nThis upgrade will:" -ForegroundColor Yellow
Write-Host " - Add a separate MySQL 8.4 StatefulSet and a new PVC."
Write-Host " - Point WordPress at the new, initially empty MySQL database."
Write-Host " - Keep the existing MariaDB StatefulSet and its PVC in place."
Write-Host " - Re-run the setup Job and seed the four HMT demo watches."
Write-Host " - Keep the legacy internal selector label to avoid immutable-selector errors."
Write-Host "`nExisting MariaDB data/PVC will NOT be deleted by this script." -ForegroundColor Green
$answer = Read-Host "Type DEPLOY to apply this Helm upgrade"
if ($answer -cne "DEPLOY") {
  Write-Host "Cancelled. No cluster changes made." -ForegroundColor Yellow
  exit 0
}

Write-Host "`nApplying Helm upgrade..." -ForegroundColor Cyan
& helm upgrade --install $Release $ChartDir `
  --namespace $ReleaseNamespace `
  --reuse-values `
  --values $ValuesFile `
  --set store.mysql.image=mysql:8.4 `
  --set store.mysql.storage=2Gi `
  --set store.mysql.storageClassName="" `
  --set store.mysql.resources.requests.cpu=100m `
  --set store.mysql.resources.requests.memory=256Mi `
  --set-string store.mysql.resources.limits.cpu=1 `
  --set store.mysql.resources.limits.memory=768Mi `
  --wait --timeout 20m
if ($LASTEXITCODE -ne 0) {
  throw "Helm upgrade failed. Existing MariaDB/PVC were not intentionally removed. Inspect: helm history $Release -n $ReleaseNamespace"
}

Write-Host "`nWaiting for MySQL and WordPress..." -ForegroundColor Cyan
& kubectl -n $StoreNamespace rollout status statefulset/mysql --timeout=10m
if ($LASTEXITCODE -ne 0) { throw "MySQL did not become ready. Keep MariaDB/PVC untouched and inspect pod logs." }
& kubectl -n $StoreNamespace rollout status deployment/wordpress --timeout=10m
if ($LASTEXITCODE -ne 0) { throw "WordPress did not become ready. Keep MariaDB/PVC untouched and inspect pod logs." }

Write-Host "`nCurrent store resources:" -ForegroundColor Cyan
& kubectl -n $StoreNamespace get pods,svc,endpoints,pvc -o wide
Write-Host "`nSetup Job logs (look for created/updated HMT products):" -ForegroundColor Cyan
& kubectl -n $StoreNamespace logs job/wordpress-setup
Write-Host "`nOpen http://shop.localtest.me and verify HMT Pilot, HMT Sona, HMT Kohinoor, and HMT Janata." -ForegroundColor Green
Write-Host "Do NOT delete MariaDB or its PVC until you have confirmed the new store works." -ForegroundColor Yellow
