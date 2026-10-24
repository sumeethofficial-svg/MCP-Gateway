#!/usr/bin/env bash
# Checks multi-store isolation and the provisioner's confinement against the running cluster. Each line prints PASS or FAIL.
# Needs kubectl (as a cluster admin: it impersonates the provisioner) and, for the cross-store checks, at least two stores in
# the Ready state: create them in the dashboard first (Stores -> Create store, wait for "Ready").
set -uo pipefail
pass=0; fail=0; skip=0
check() { # check <description> <expected: 0 = command must succeed, 1 = must fail> <command...>
  local desc="$1" expect="$2"; shift 2
  if "$@" >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" = "$expect" ]; then echo "PASS  $desc"; pass=$((pass+1)); else echo "FAIL  $desc"; fail=$((fail+1)); fi
}
tcp_from_default() { # raw TCP connect from an unrelated namespace
  kubectl run "tcp-$RANDOM" -n default --rm -i --restart=Never --quiet --image=busybox:1.36 --command -- nc -z -w 5 "$1" "$2"
}
tcp_from_store() { # tcp_from_store <namespace> <host> <port>: from that store's own woo-mcp pod
  kubectl exec -n "$1" deploy/woo-mcp -- nc -z -w 4 "$2" "$3"
}
from_gateway() { kubectl exec -n platform deploy/gateway -- node -e "$1"; }
can() { kubectl auth can-i "$@" 2>/dev/null | grep -qx yes; }
PROV="--as=system:serviceaccount:platform:provisioner"

STORES=()
for n in $(kubectl get ns -l mcp-portal.io/store=true -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
  [ "$(kubectl get ns "$n" -o go-template='{{index .metadata.annotations "mcp-portal.io/phase"}}' 2>/dev/null)" = Ready ] && STORES+=("$n")
done
echo "Found ${#STORES[@]} Ready store(s): ${STORES[*]:-none}"

echo; echo "Every store has its guardrails"
for ns in "${STORES[@]}"; do
  check "$ns: ResourceQuota present"                 0 kubectl get resourcequota -n "$ns" -o name --no-headers
  check "$ns: LimitRange present"                    0 kubectl get limitrange -n "$ns" -o name --no-headers
  check "$ns: default-deny NetworkPolicy present"    0 kubectl get networkpolicy default-deny-all -n "$ns"
  check "$ns: Pod Security baseline enforced"        0 bash -c "[ \"\$(kubectl get ns $ns -o jsonpath='{.metadata.labels.pod-security\\.kubernetes\\.io/enforce}')\" = baseline ]"
  check "$ns: own database credentials exist"        0 kubectl get secret mysql-credentials -n "$ns"
  check "$ns: own storage (PVCs) exist"              0 bash -c "[ \$(kubectl get pvc -n $ns --no-headers | wc -l) -ge 2 ]"
  check "$ns: own Ingress host"                      0 bash -c "kubectl get ingress -n $ns -o jsonpath='{.items[0].spec.rules[0].host}' | grep -q '\\.'"
  check "$ns: the gateway can reach its woo-mcp"     0 from_gateway "fetch('http://woo-mcp.$ns.svc.cluster.local:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  check "$ns: woo-mcp refuses a call without a token (401)" 0 from_gateway "fetch('http://woo-mcp.$ns.svc.cluster.local:8080/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:'{}'}).then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
  check "$ns: not reachable from another namespace (woo-mcp)"  1 tcp_from_default "woo-mcp.$ns.svc.cluster.local" 8080
  check "$ns: not reachable from another namespace (MySQL)"    1 tcp_from_default "mysql.$ns.svc.cluster.local" 3306
  check "$ns: not reachable from another namespace (WordPress)" 1 tcp_from_default "wordpress.$ns.svc.cluster.local" 80
done

if [ "${#STORES[@]}" -ge 2 ]; then
  A="${STORES[0]}"; B="${STORES[1]}"
  echo; echo "Store A ($A) cannot reach store B ($B)"
  check "A's woo-mcp can reach A's own WordPress (control)"  0 tcp_from_store "$A" wordpress 80
  check "A's woo-mcp cannot reach B's woo-mcp"               1 tcp_from_store "$A" "woo-mcp.$B.svc.cluster.local" 8080
  check "A's woo-mcp cannot reach B's WordPress"             1 tcp_from_store "$A" "wordpress.$B.svc.cluster.local" 80
  check "A's woo-mcp cannot reach B's MySQL"                 1 tcp_from_store "$A" "mysql.$B.svc.cluster.local" 3306
  check "A and B have different database passwords"          0 bash -c "[ \"\$(kubectl get secret mysql-credentials -n $A -o jsonpath='{.data.password}')\" != \"\$(kubectl get secret mysql-credentials -n $B -o jsonpath='{.data.password}')\" ]"
  check "A and B have different MCP tokens"                  0 bash -c "[ \"\$(kubectl get secret woo-mcp-auth -n $A -o jsonpath='{.data.token}')\" != \"\$(kubectl get secret woo-mcp-auth -n $B -o jsonpath='{.data.token}')\" ]"
  check "A's MCP token is refused by B (401)"                0 from_gateway "const t=Buffer.from('$(kubectl get secret woo-mcp-auth -n "$A" -o jsonpath='{.data.token}')','base64').toString();fetch('http://woo-mcp.$B.svc.cluster.local:8080/mcp',{method:'POST',headers:{authorization:'Bearer '+t,'content-type':'application/json',accept:'application/json, text/event-stream'},body:'{}'}).then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
else
  echo; echo "SKIP  cross-store checks need two Ready stores (create them in the dashboard, then run this again)"; skip=1
fi

echo; echo "The provisioner is confined (asked of the API server itself; the last four exercise the admission policies)"
check "can create namespaces (it must be able to)"          0 can $PROV create namespaces
check "can NOT read Secrets in platform"                    1 can $PROV get secrets -n platform
check "can NOT read Secrets in kube-system"                 1 can $PROV get secrets -n kube-system
check "can NOT create Deployments in platform"              1 can $PROV create deployments -n platform
check "can NOT touch ClusterRoles or nodes"                 1 can $PROV create clusterroles
check "can NOT list nodes"                                  1 can $PROV list nodes
check "can NOT create a namespace that is not store-*"      1 kubectl create namespace hacked --dry-run=server $PROV
check "can NOT create an unlabelled store-* namespace"      1 kubectl create namespace store-unlabelled --dry-run=server $PROV
check "can NOT delete kube-system"                          1 kubectl delete namespace kube-system --dry-run=server $PROV
check "can NOT bind itself into kube-system"                1 kubectl create rolebinding sneaky --clusterrole=mcp-store-admin --serviceaccount=platform:provisioner -n kube-system --dry-run=server $PROV
check "CAN create a correctly labelled store namespace"     0 bash -c "printf 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: store-zzverify\n  labels:\n    mcp-portal.io/store: \"true\"\n    pod-security.kubernetes.io/enforce: baseline\n' | kubectl create -f - --dry-run=server $PROV"

echo; echo "The provisioner's API"
check "refuses a call without its token (401)"              0 from_gateway "fetch('http://provisioner.platform.svc.cluster.local:8080/stores').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
check "is not reachable from another namespace"             1 tcp_from_default provisioner.platform.svc.cluster.local 8080
check "has no Ingress (it is internal only)"                1 bash -c "kubectl get ingress -A -o json | grep -q provisioner"

echo; echo "$pass passed, $fail failed$([ "$skip" = 1 ] && echo ", cross-store checks skipped")"
[ "$fail" = 0 ]
