{{/* Image reference: <registry>/mcp-portal-<name>:<tag> (registry optional). */}}
{{- define "mcp-portal.image" -}}
{{- $r := .root.Values.image.registry -}}
{{- if $r -}}{{ $r }}/mcp-portal-{{ .name }}:{{ .root.Values.image.tag }}{{- else -}}mcp-portal-{{ .name }}:{{ .root.Values.image.tag }}{{- end -}}
{{- end -}}

{{/* Standard labels. args: root, component, name.
   part-of stays "storegate" on purpose: the label is part of the immutable selectors of the StatefulSets and
   Deployments created under that name, so renaming it would make `helm upgrade` fail on existing clusters. */}}
{{- define "mcp-portal.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: storegate
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | quote }}
{{- end -}}

{{- define "mcp-portal.selector" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: storegate
{{- end -}}

{{- define "mcp-portal.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{/*
Secret value that is stable across upgrades and consistent across namespaces.
Order of precedence: explicit value, the value already stored in the cluster (lookup), a fresh random value.
The result is memoised under `id` for the duration of one render so two Secrets that must agree
(the woo-mcp token exists in both namespaces) always receive the same value.
args: root, id, ns, secret, key, len, override
*/}}
{{- define "mcp-portal.secretValue" -}}
{{- $root := .root -}}
{{- if not (hasKey $root.Values "_generated") -}}{{- $_ := set $root.Values "_generated" (dict) -}}{{- end -}}
{{- $cache := index $root.Values "_generated" -}}
{{- if not (hasKey $cache .id) -}}
  {{- $value := .override | default "" -}}
  {{- if not $value -}}
    {{- $existing := lookup "v1" "Secret" .ns .secret -}}
    {{- if and $existing (hasKey $existing "data") (hasKey $existing.data .key) -}}
      {{- $value = index $existing.data .key | b64dec -}}
    {{- else -}}
      {{- $value = randAlphaNum (int .len) -}}
    {{- end -}}
  {{- end -}}
  {{- $_ := set $cache .id $value -}}
{{- end -}}
{{- index $cache .id -}}
{{- end -}}

{{/* Hardened container security context (non-root, no escalation, read-only root fs, no capabilities). */}}
{{- define "mcp-portal.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "mcp-portal.podSecurity" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/*
A stateless Node/MCP workload: Deployment + Service. args: root, ns, name, component, image, port, replicas,
resources, envYaml (pre-rendered YAML list items), healthPath (optional readiness path), checksum (optional),
automountToken (optional, default false: only kube-ops-mcp talks to the Kubernetes API and gets a token)
*/}}
{{- define "mcp-portal.nodeWorkload" -}}
{{- $r := .root -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  namespace: {{ .ns }}
  labels:
    {{- include "mcp-portal.labels" (dict "root" $r "component" .component "name" .name) | nindent 4 }}
spec:
  replicas: {{ .replicas | default 1 }}
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxUnavailable: 0, maxSurge: 1}
  selector:
    matchLabels:
      {{- include "mcp-portal.selector" (dict "name" .name) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "mcp-portal.labels" (dict "root" $r "component" .component "name" .name) | nindent 8 }}
      {{- with .checksum }}
      annotations:
        checksum/config: {{ . }}
      {{- end }}
    spec:
      serviceAccountName: {{ .name }}
      automountServiceAccountToken: {{ .automountToken | default false }}
      {{- include "mcp-portal.imagePullSecrets" $r | nindent 6 }}
      securityContext:
        {{- include "mcp-portal.podSecurity" . | nindent 8 }}
      terminationGracePeriodSeconds: 20
      containers:
        - name: {{ .name }}
          image: {{ .image }}
          imagePullPolicy: {{ $r.Values.image.pullPolicy }}
          ports:
            - {name: http, containerPort: {{ .port }}}
          env:
            - {name: PORT, value: {{ .port | quote }}}
            - {name: NODE_ENV, value: production}
            {{- with .envYaml }}
            {{- . | nindent 12 }}
            {{- end }}
          startupProbe:
            httpGet: {path: {{ .healthPath | default "/healthz" }}, port: http}
            periodSeconds: 3
            failureThreshold: {{ .startupFailures | default 30 }}
          livenessProbe:
            httpGet: {path: /healthz, port: http}
            periodSeconds: 15
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet: {path: {{ .healthPath | default "/readyz" }}, port: http}
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            {{- toYaml .resources | nindent 12 }}
          securityContext:
            {{- include "mcp-portal.containerSecurity" . | nindent 12 }}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: tmp
          emptyDir: {sizeLimit: 64Mi}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .name }}
  namespace: {{ .ns }}
  labels:
    {{- include "mcp-portal.labels" (dict "root" $r "component" .component "name" .name) | nindent 4 }}
automountServiceAccountToken: {{ .automountToken | default false }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  namespace: {{ .ns }}
  labels:
    {{- include "mcp-portal.labels" (dict "root" $r "component" .component "name" .name) | nindent 4 }}
spec:
  selector:
    {{- include "mcp-portal.selector" (dict "name" .name) | nindent 4 }}
  ports:
    - {name: http, port: {{ .port }}, targetPort: http}
{{- end -}}

{{/* PodDisruptionBudget for multi-replica workloads. args: ns, name, replicas */}}
{{- define "mcp-portal.pdb" -}}
{{- if gt (int .replicas) 1 }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ .name }}
  namespace: {{ .ns }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- include "mcp-portal.selector" (dict "name" .name) | nindent 6 }}
{{- end }}
{{- end -}}

{{/* Metadata shared by generated Secrets: kept on uninstall so volumes and credentials stay paired. */}}
{{- define "mcp-portal.secretMeta" }}
  labels:
    app.kubernetes.io/part-of: storegate
  annotations:
    helm.sh/resource-policy: keep
{{- end }}