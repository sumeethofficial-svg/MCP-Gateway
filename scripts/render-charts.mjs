#!/usr/bin/env node
/**
 * Renders charts/mcp-portal for every values profile and lints the result against the conventions this repo promises:
 * probes, resource requests/limits, hardened security contexts, Secret/Service/Ingress/PVC wiring, default-deny
 * NetworkPolicies, and a matching woo-mcp token in both namespaces.
 *
 * Uses `helm template` when Helm is installed; otherwise it needs Go (stdlib only) as a stand-in for the template pass.
 * Run `helm lint` too (`make chart-lint`).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chart = path.join(root, "charts/mcp-portal");
const profiles = { defaults: [], local: ["values-local.yaml"], "local+nginx": ["values-local.yaml", "values-nginx.yaml"], prod: ["values-prod.yaml"] };

const merge = (a, b) => {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) out[k] = k in out && typeof out[k] === "object" && !Array.isArray(out[k]) ? merge(out[k], v) : v;
  return out;
};

let failures = 0;
const fail = (profile, msg) => {
  failures++;
  console.error(`  ✗ [${profile}] ${msg}`);
};

function render(profile, files, extra = {}) {
  let values = parse(readFileSync(path.join(chart, "values.yaml"), "utf8"));
  for (const f of files) values = merge(values, parse(readFileSync(path.join(chart, f), "utf8")));
  values = merge(values, extra);
  const dir = mkdtempSync(path.join(tmpdir(), "chart-"));
  const vfile = path.join(dir, "values.json");
  writeFileSync(vfile, JSON.stringify(values));
  // Prefer the real Helm when it is installed; fall back to the Go stand-in otherwise.
  const hasHelm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
  const r = hasHelm
    ? spawnSync("helm", ["template", "mcp-portal", chart, "-f", vfile, "--namespace", "default"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    : spawnSync("go", ["run", ".", "-chart", chart, "-values", vfile], { cwd: path.join(root, "scripts/chart-render"), encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.error?.message ?? r.stderr ?? "renderer failed (is Helm or Go installed?)");
    fail(profile, "template rendering failed");
    return undefined;
  }
  return r.stdout;
}

function lint(profile, text) {
  if (text.includes("<no value>")) fail(profile, "a template referenced a missing value (<no value>)");
  const docs = [];
  for (const d of parseAllDocuments(text)) {
    if (d.errors.length) fail(profile, `invalid YAML: ${d.errors[0].message}`);
    const obj = d.toJS();
    if (obj) docs.push(obj);
  }
  const key = (d) => `${d.kind}/${d.metadata?.namespace ?? ""}/${d.metadata?.name}`;
  const byKind = (k) => docs.filter((d) => d.kind === k);
  const exists = (kind, ns, name) => docs.some((d) => d.kind === kind && d.metadata?.name === name && (d.metadata?.namespace ?? "") === ns);
  const cluster = new Set(["Namespace", "ClusterRole", "ClusterRoleBinding", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]);

  for (const d of docs) {
    if (!d.apiVersion || !d.kind || !d.metadata?.name) fail(profile, `document without apiVersion/kind/name: ${JSON.stringify(d).slice(0, 80)}`);
    if (!cluster.has(d.kind) && !d.metadata?.namespace) fail(profile, `${key(d)} has no namespace`);
  }
  const seen = new Set();
  for (const d of docs) {
    const k = key(d);
    if (seen.has(k)) fail(profile, `duplicate resource ${k}`);
    seen.add(k);
  }

  // ---- RBAC: kube-ops-mcp must stay least-privilege; the provisioner is the one reviewed exception ----
  // Cluster-wide objects are allowed only for the provisioner's three named roles (see templates/stores-rbac.yaml).
  const storeRoles = new Set(["mcp-store-namespaces", "mcp-store-binder", "mcp-store-admin"]);
  const roles = [...byKind("Role"), ...byKind("ClusterRole")];
  for (const r of [...byKind("ClusterRole"), ...byKind("ClusterRoleBinding")]) if (!storeRoles.has(r.metadata.name)) fail(profile, `cluster-wide RBAC is not allowed: ${key(r)}`);
  for (const r of roles.filter((x) => !storeRoles.has(x.metadata.name))) {
    for (const rule of r.rules ?? []) {
      if ((rule.resources ?? []).some((x) => x === "secrets" || x === "*" || x.startsWith("pods/exec") || x === "configmaps")) fail(profile, `${key(r)} grants ${rule.resources}`);
      const writes = (rule.verbs ?? []).some((v) => ["patch", "update", "create", "delete", "*"].includes(v));
      if (writes && !(rule.resourceNames ?? []).length) fail(profile, `${key(r)} has a write verb without resourceNames`);
    }
  }
  for (const w of ["gateway", "postgres", "kube-ops-mcp"]) {
    for (const r of roles.filter((x) => x.metadata.name === "kube-ops-write"))
      if (r.rules.some((rule) => (rule.resourceNames ?? []).includes(w))) fail(profile, `kube-ops-write may modify ${w}`);
  }
  const storesOn = byKind("ClusterRole").length > 0;
  if (storesOn) {
    const role = (n) => byKind("ClusterRole").find((x) => x.metadata.name === n);
    const allRules = (n) => role(n)?.rules ?? [];
    for (const n of storeRoles) if (!role(n)) fail(profile, `ClusterRole ${n} is missing`);
    const dangerous = ["nodes", "clusterroles", "clusterrolebindings", "roles", "rolebindings", "customresourcedefinitions", "validatingadmissionpolicies", "persistentvolumes", "*"];
    for (const rule of allRules("mcp-store-admin")) if ((rule.resources ?? []).some((x) => dangerous.includes(x)) || (rule.verbs ?? []).includes("*")) fail(profile, `mcp-store-admin grants ${rule.resources}`);
    const nsRule = allRules("mcp-store-namespaces");
    if (nsRule.length !== 1 || nsRule[0].resources.join() !== "namespaces") fail(profile, "mcp-store-namespaces may only touch namespaces");
    for (const rule of allRules("mcp-store-binder")) {
      const isBind = rule.verbs.includes("bind");
      if (isBind && (rule.resourceNames ?? []).join() !== "mcp-store-admin") fail(profile, "the provisioner may bind only mcp-store-admin");
      if (!isBind && (rule.resources.join() !== "rolebindings" || rule.verbs.some((v) => !["get", "create"].includes(v)))) fail(profile, "mcp-store-binder may only get/create rolebindings");
    }
    for (const b of byKind("ClusterRoleBinding"))
      if (b.subjects.some((x) => x.kind !== "ServiceAccount" || x.name !== "provisioner")) fail(profile, `${key(b)} binds something other than the provisioner`);
    const vaps = byKind("ValidatingAdmissionPolicy").map((x) => x.metadata.name);
    for (const n of ["mcp-store-namespaces", "mcp-store-rolebindings"]) {
      if (!vaps.includes(n)) fail(profile, `admission policy ${n} is missing: the provisioner would not be confined to store namespaces`);
      if (!byKind("ValidatingAdmissionPolicyBinding").some((x) => x.spec.policyName === n && x.spec.validationActions.includes("Deny"))) fail(profile, `admission policy ${n} has no Deny binding`);
    }
    for (const v of byKind("ValidatingAdmissionPolicy")) if (v.spec.failurePolicy !== "Fail") fail(profile, `${key(v)} must fail closed`);
  }

  // ---- workloads ----
  const workloads = docs.filter((d) => ["Deployment", "StatefulSet", "Job"].includes(d.kind));
  for (const w of workloads) {
    const ns = w.metadata.namespace;
    const spec = w.spec.template.spec;
    const label = key(w);
    // kube-ops-mcp is the one workload that talks to the Kubernetes API; rbac.yaml defines what that token may do.
    if (spec.automountServiceAccountToken !== false && !["kube-ops-mcp", "provisioner"].includes(w.metadata.name)) fail(profile, `${label}: service account token is auto-mounted`);
    const volumes = new Map((spec.volumes ?? []).map((v) => [v.name, v]));
    for (const v of volumes.values()) {
      if (v.persistentVolumeClaim && !exists("PersistentVolumeClaim", ns, v.persistentVolumeClaim.claimName)) fail(profile, `${label}: PVC ${v.persistentVolumeClaim.claimName} is not defined`);
      if (v.configMap && !exists("ConfigMap", ns, v.configMap.name)) fail(profile, `${label}: ConfigMap ${v.configMap.name} is not defined`);
    }
    if (w.kind === "StatefulSet") for (const t of w.spec.volumeClaimTemplates ?? []) volumes.set(t.metadata.name, t);
    for (const c of spec.containers) {
      const where = `${label}/${c.name}`;
      if (!c.image || c.image.endsWith(":latest") || !c.image.includes(":")) fail(profile, `${where}: image must have an explicit non-latest tag (${c.image})`);
      if (!c.resources?.requests?.cpu || !c.resources?.requests?.memory || !c.resources?.limits?.memory) fail(profile, `${where}: needs resource requests and a memory limit`);
      const sc = c.securityContext ?? {};
      if (sc.allowPrivilegeEscalation !== false) fail(profile, `${where}: allowPrivilegeEscalation must be false`);
      if (!sc.capabilities?.drop?.includes("ALL")) fail(profile, `${where}: must drop ALL capabilities`);
      if (w.kind !== "Job") {
        if (!c.readinessProbe) fail(profile, `${where}: no readinessProbe`);
        if (!c.livenessProbe) fail(profile, `${where}: no livenessProbe`);
      }
      const portNames = new Set((c.ports ?? []).map((p) => p.name));
      for (const p of [c.startupProbe, c.livenessProbe, c.readinessProbe]) {
        const port = p?.httpGet?.port ?? p?.tcpSocket?.port;
        if (typeof port === "string" && !portNames.has(port)) fail(profile, `${where}: probe uses undefined port name "${port}"`);
      }
      for (const m of c.volumeMounts ?? []) if (!volumes.has(m.name)) fail(profile, `${where}: mounts undefined volume ${m.name}`);
      for (const e of c.env ?? []) {
        const ref = e.valueFrom?.secretKeyRef;
        if (!ref) continue;
        const secret = docs.find((d) => d.kind === "Secret" && d.metadata.name === ref.name && d.metadata.namespace === ns);
        if (!secret) fail(profile, `${where}: env ${e.name} references missing Secret ${ref.name} in ${ns}`);
        else if (!(ref.key in (secret.stringData ?? secret.data ?? {}))) fail(profile, `${where}: Secret ${ref.name} has no key ${ref.key}`);
      }
      // Anything that looks like a credential must come from a Secret, never a literal.
      for (const e of c.env ?? []) if (e.value && /(PASSWORD|TOKEN|SECRET|KEY)$/.test(e.name) && !e.valueFrom && !/^(PORT|NODE_ENV)$/.test(e.name)) fail(profile, `${where}: ${e.name} is a literal; credentials must come from a Secret`);
    }
    const ps = spec.securityContext ?? {};
    if (!ps.seccompProfile) fail(profile, `${label}: no pod seccompProfile`);
  }

  // ---- services must select something ----
  const podLabels = workloads.map((w) => ({ ns: w.metadata.namespace, labels: w.spec.template.metadata.labels ?? {}, ports: w.spec.template.spec.containers.flatMap((c) => c.ports ?? []) }));
  for (const s of byKind("Service")) {
    const match = podLabels.find((p) => p.ns === s.metadata.namespace && Object.entries(s.spec.selector).every(([k, v]) => p.labels[k] === v));
    if (!match) fail(profile, `${key(s)} selects no workload`);
    else for (const port of s.spec.ports) if (typeof port.targetPort === "string" && !match.ports.some((p) => p.name === port.targetPort)) fail(profile, `${key(s)}: targetPort ${port.targetPort} not exposed by the pods`);
  }
  // ---- ingress backends ----
  for (const i of byKind("Ingress"))
    for (const rule of i.spec.rules) for (const p of rule.http.paths) if (!exists("Service", i.metadata.namespace, p.backend.service.name)) fail(profile, `${key(i)} routes to missing Service ${p.backend.service.name}`);

  // ---- network isolation ----
  for (const ns of new Set(workloads.map((w) => w.metadata.namespace))) {
    const policies = byKind("NetworkPolicy").filter((n) => n.metadata.namespace === ns);
    const deny = policies.find((n) => Object.keys(n.spec.podSelector ?? {}).length === 0 && n.spec.policyTypes?.includes("Ingress") && n.spec.policyTypes?.includes("Egress") && !n.spec.ingress && !n.spec.egress);
    if (!deny) fail(profile, `namespace ${ns} has no default-deny NetworkPolicy`);
  }
  const provPolicy = byKind("NetworkPolicy").find((n) => n.metadata.name === "provisioner");
  if (storesOn && !provPolicy) fail(profile, "the provisioner has no NetworkPolicy");
  if (provPolicy) {
    const pf = provPolicy.spec.ingress?.flatMap((r) => r.from ?? []) ?? [];
    if (pf.length !== 1 || pf[0].podSelector?.matchLabels?.["app.kubernetes.io/name"] !== "gateway") fail(profile, "the provisioner must accept traffic only from the gateway pods");
  }
  const wooPolicy = byKind("NetworkPolicy").find((n) => n.metadata.name === "woo-mcp");
  const from = wooPolicy?.spec.ingress?.flatMap((r) => r.from ?? []) ?? [];
  if (from.length !== 1 || from[0].podSelector?.matchLabels?.["app.kubernetes.io/name"] !== "gateway") fail(profile, "woo-mcp must accept traffic only from the gateway pods");

  // ---- secrets agree across namespaces ----
  const tokens = byKind("Secret").flatMap((s) => [s.stringData?.token && ["woo-mcp-auth", s.stringData.token], s.stringData?.WOO_MCP_TOKEN && ["upstream-tokens", s.stringData.WOO_MCP_TOKEN]]).filter(Boolean);
  if (new Set(tokens.map((t) => t[1])).size !== 1 || tokens.length !== 2) fail(profile, "the woo-mcp token differs between namespaces");
  const enc = byKind("Secret").find((s) => s.metadata.name === "gateway-secrets")?.stringData?.ENCRYPTION_KEY;
  if (!enc || Buffer.from(enc, "base64").length !== 32) fail(profile, "ENCRYPTION_KEY must decode to 32 bytes");
  for (const s of byKind("Secret")) if (s.metadata.annotations?.["helm.sh/resource-policy"] !== "keep") fail(profile, `${key(s)} should be kept on uninstall`);

  // ---- gateway wiring ----
  const gw = workloads.find((w) => w.metadata.name === "gateway");
  const env = Object.fromEntries((gw?.spec.template.spec.containers[0].env ?? []).map((e) => [e.name, e.value ?? e.valueFrom]));
  try {
    const seeded = JSON.parse(env.SEEDED_UPSTREAMS);
    const allow = String(env.UPSTREAM_PRIVATE_ALLOWLIST).split(",");
    if (seeded.length < 3) fail(profile, "the gateway must seed at least three upstreams");
    for (const s of seeded) {
      const host = new URL(s.url).hostname;
      if (!allow.includes(host)) fail(profile, `seeded upstream ${s.slug} (${host}) is not on the private allowlist`);
      if (s.credentialEnv && !(s.credentialEnv in env)) fail(profile, `seeded upstream ${s.slug} references undefined env ${s.credentialEnv}`);
      const svcNs = host.split(".")[1];
      if (!exists("Service", svcNs, host.split(".")[0])) fail(profile, `seeded upstream ${s.slug} points at missing Service ${host}`);
    }
  } catch (e) {
    fail(profile, `SEEDED_UPSTREAMS is not valid JSON: ${e.message}`);
  }
  if (storesOn) {
    if (!/^http:\/\/provisioner\.platform\.svc\.cluster\.local:8080$/.test(String(env.PROVISIONER_URL))) fail(profile, "PROVISIONER_URL must point at the provisioner Service");
    if (!("PROVISIONER_TOKEN" in env)) fail(profile, "the gateway has no PROVISIONER_TOKEN");
    if (!exists("Service", "platform", "provisioner")) fail(profile, "the provisioner has no Service");
    const prov = workloads.find((w) => w.metadata.name === "provisioner");
    const penv = Object.fromEntries((prov?.spec.template.spec.containers[0].env ?? []).map((e) => [e.name, e.value ?? e.valueFrom]));
    if (prov?.spec.template.spec.serviceAccountName !== "provisioner") fail(profile, "the provisioner must run as the provisioner ServiceAccount");
    try {
      JSON.parse(penv.STORE_VALUES_JSON);
    } catch {
      fail(profile, "STORE_VALUES_JSON is not valid JSON");
    }
    if (!String(env.UPSTREAM_PRIVATE_ALLOWLIST).split(",").some((h) => /^woo-mcp\.[a-z0-9-]+\*\.svc\.cluster\.local$/.test(h))) fail(profile, "the gateway allowlist does not cover store woo-mcp hosts");
  }
  if (env.UPSTREAM_ALLOW_LOOPBACK !== undefined) fail(profile, "UPSTREAM_ALLOW_LOOPBACK must never be set in a chart");
  return docs;
}

for (const [name, files] of Object.entries(profiles)) {
  console.log(`rendering [${name}]`);
  const out = render(name, files);
  if (!out) continue;
  const docs = lint(name, out);
  console.log(`  ${docs?.length ?? 0} resources`);
  mkdirSync(path.join(root, ".rendered"), { recursive: true });
  writeFileSync(path.join(root, ".rendered", `${name}.yaml`), out);
}

// ---- charts/mcp-store: one store, rendered the way the provisioner does ----
function renderStore(extra = {}, id = "berlin") {
  const sc = path.join(root, "charts/mcp-store");
  const values = merge(parse(readFileSync(path.join(sc, "values.yaml"), "utf8")), { store: { id, name: id, ownerId: "u1" }, ...extra });
  const dir = mkdtempSync(path.join(tmpdir(), "store-"));
  const vfile = path.join(dir, "values.json");
  writeFileSync(vfile, JSON.stringify(values));
  const hasHelm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
  const r = hasHelm
    ? spawnSync("helm", ["template", "store", sc, "-f", vfile, "--namespace", `store-${id}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    : spawnSync("go", ["run", ".", "-chart", sc, "-values", vfile, "-release", "store", "-namespace", `store-${id}`], { cwd: path.join(root, "scripts/chart-render"), encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.error?.message ?? r.stderr ?? "renderer failed");
    fail("store", "template rendering failed");
    return undefined;
  }
  return r.stdout;
}

function lintStore(text) {
  const P = "store";
  if (text.includes("<no value>")) fail(P, "a template referenced a missing value (<no value>)");
  const docs = [];
  for (const d of parseAllDocuments(text)) {
    if (d.errors.length) fail(P, `invalid YAML: ${d.errors[0].message}`);
    const obj = d.toJS();
    if (obj) docs.push(obj);
  }
  const of = (k) => docs.filter((d) => d.kind === k);
  const name = (d) => `${d.kind}/${d.metadata?.name}`;
  // Everything a store creates is namespaced by the install and carries the store id; nothing may escape its namespace.
  for (const d of docs) {
    if (["Namespace", "ClusterRole", "ClusterRoleBinding", "PersistentVolume", "CustomResourceDefinition"].includes(d.kind)) fail(P, `${name(d)} is cluster-scoped`);
    if (d.metadata?.namespace && d.metadata.namespace !== "store-berlin") fail(P, `${name(d)} sets namespace ${d.metadata.namespace}`);
    if (!["Secret", "ConfigMap"].includes(d.kind) && d.metadata?.labels?.["mcp-portal.io/store-id"] !== "berlin") fail(P, `${name(d)} is not labelled with the store id`);
  }
  for (const k of ["ResourceQuota", "LimitRange"]) if (of(k).length !== 1) fail(P, `expected exactly one ${k}`);
  const deny = of("NetworkPolicy").find((n) => Object.keys(n.spec.podSelector ?? {}).length === 0 && n.spec.policyTypes?.includes("Ingress") && n.spec.policyTypes?.includes("Egress") && !n.spec.ingress && !n.spec.egress);
  if (!deny) fail(P, "no default-deny NetworkPolicy");
  // The only rules that may select across namespaces: ingress controller, DNS, and the gateway.
  for (const n of of("NetworkPolicy"))
    for (const rule of [...(n.spec.ingress ?? []), ...(n.spec.egress ?? [])])
      for (const peer of [...(rule.from ?? []), ...(rule.to ?? [])]) {
        const nsName = peer.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"];
        if (peer.namespaceSelector && !["kube-system", "platform"].includes(nsName)) fail(P, `${name(n)} selects namespace ${JSON.stringify(peer.namespaceSelector)}`);
      }
  const woo = of("NetworkPolicy").find((n) => n.metadata.name === "woo-mcp");
  const from = woo?.spec.ingress?.flatMap((r) => r.from ?? []) ?? [];
  if (from.length !== 1 || from[0].podSelector?.matchLabels?.["app.kubernetes.io/name"] !== "gateway" || from[0].namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] !== "platform") fail(P, "woo-mcp must accept traffic only from the gateway pods");
  for (const w of docs.filter((d) => ["Deployment", "StatefulSet", "Job"].includes(d.kind))) {
    const spec = w.spec.template.spec;
    if (spec.automountServiceAccountToken !== false) fail(P, `${name(w)}: service account token is auto-mounted`);
    for (const c of spec.containers) {
      if (!c.resources?.requests?.cpu || !c.resources?.limits?.memory) fail(P, `${name(w)}/${c.name}: needs requests and a memory limit`);
      if (!c.image || c.image.endsWith(":latest")) fail(P, `${name(w)}/${c.name}: image needs a non-latest tag`);
    }
  }
  const secrets = of("Secret");
  for (const s of secrets) if (s.metadata.annotations?.["helm.sh/resource-policy"] === "keep") fail(P, `${name(s)} would outlive the store: teardown must remove it`);
  for (const p of of("PersistentVolumeClaim")) if (p.metadata.annotations?.["helm.sh/resource-policy"] === "keep") fail(P, `${name(p)} would outlive the store`);
  const ing = of("Ingress");
  if (ing.length !== 1 || ing[0].spec.rules[0].host !== "berlin.stores.localtest.me") fail(P, "the store Ingress host is not <id>.<domain.base>");
  const token = secrets.find((s) => s.metadata.name === "woo-mcp-auth")?.stringData?.token;
  if (!token || token.length < 32) fail(P, "woo-mcp-auth needs a generated token of at least 32 characters");
  return docs;
}

{
  console.log("rendering [store]");
  const out = renderStore();
  if (out) {
    const docs = lintStore(out);
    console.log(`  ${docs?.length ?? 0} resources`);
    writeFileSync(path.join(root, ".rendered", "store.yaml"), out);
  }
  // Two stores must not share names, hosts or secrets by accident: a different id renders a different host.
  const other = renderStore({}, "paris");
  if (other && other.includes("berlin")) fail("store", "a store render leaked another store's id");
}

// A production render must not ship the malicious fixture or anything predictable.
{
  const out = render("prod-checks", profiles.prod);
    if (out) {
        const hit = out.replace(/# Source:.*/g, "").match(/name: malicious-test|mcp-portal-evil-mcp/);
    if (hit) fail("prod", `the malicious-test fixture must not be deployed in production values (matched: ${hit[0]})`);
    if (/mcp-portal-admin-1|shop-admin-local-1/.test(out)) fail("prod", "a local demo password leaked into the production render");
  }
}

if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log("\nchart checks passed");
