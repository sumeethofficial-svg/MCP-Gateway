{{/* Image reference: <registry>/mcp-portal-<name>:<tag> (registry optional). */}}
{{- define "mcp-store.image" -}}
{{- $r := .root.Values.image.registry -}}
{{- if $r -}}{{ $r }}/mcp-portal-{{ .name }}:{{ .root.Values.image.tag }}{{- else -}}mcp-portal-{{ .name }}:{{ .root.Values.image.tag }}{{- end -}}
{{- end -}}

{{/* The store's public host. */}}
{{- define "mcp-store.host" -}}
{{ printf "%s.%s" .Values.store.id .Values.domain.base }}
{{- end -}}

{{- define "mcp-store.siteUrl" -}}
{{ printf "%s://%s" .Values.ingress.scheme (include "mcp-store.host" .) }}
{{- end -}}

{{/* Labels. args: root, component, name. Every object carries the store id so `kubectl get -A -l mcp-portal.io/store-id=x` finds all of it. */}}
{{- define "mcp-store.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: mcp-store
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | quote }}
mcp-portal.io/store-id: {{ .root.Values.store.id | quote }}
{{- end -}}

{{- define "mcp-store.selector" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: mcp-store
{{- end -}}

{{- define "mcp-store.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{/* Stable generated secret value: the one already in the cluster, else a fresh random one. args: root, id, secret, key, len */}}
{{- define "mcp-store.secretValue" -}}
{{- $root := .root -}}
{{- if not (hasKey $root.Values "_generated") -}}{{- $_ := set $root.Values "_generated" (dict) -}}{{- end -}}
{{- $cache := index $root.Values "_generated" -}}
{{- if not (hasKey $cache .id) -}}
  {{- $value := "" -}}
  {{- $existing := lookup "v1" "Secret" $root.Release.Namespace .secret -}}
  {{- if and $existing (hasKey $existing "data") (hasKey $existing.data .key) -}}
    {{- $value = index $existing.data .key | b64dec -}}
  {{- else -}}
    {{- $value = randAlphaNum (int .len) -}}
  {{- end -}}
  {{- $_ := set $cache .id $value -}}
{{- end -}}
{{- index $cache .id -}}
{{- end -}}

{{- define "mcp-store.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}
