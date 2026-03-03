{{- define "chroma-memory-mcp.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chroma-memory-mcp.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chroma-memory-mcp.labels" -}}
app.kubernetes.io/name: {{ include "chroma-memory-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "chroma-memory-mcp.mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chroma-memory-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: mcp-server
{{- end -}}

{{- define "chroma-memory-mcp.chromadb.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chroma-memory-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: chromadb
{{- end -}}

{{- define "chroma-memory-mcp.baseUrl" -}}
{{- if .Values.ingress.tls.enabled -}}
https://{{ .Values.ingress.host }}
{{- else -}}
http://{{ .Values.ingress.host }}
{{- end -}}
{{- end -}}

{{- define "chroma-memory-mcp.chromaUrl" -}}
http://{{ include "chroma-memory-mcp.fullname" . }}-chromadb:{{ .Values.chromadb.port }}
{{- end -}}
