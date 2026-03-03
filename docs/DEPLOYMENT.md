# Deployment Guide

Internal deployment instructions for chroma-memory-mcp.

## Infrastructure

| Component | Image | Port |
|-----------|-------|------|
| MCP Server | `sfrangulov/chroma-memory-mcp:<tag>` | 3000 |
| ChromaDB | `chromadb/chroma:1.5.2` | 8000 |
| Redis | `redis:7-alpine` | 6379 |

**Cluster:** MicroK8s at `77.68.87.78:16443`
**Namespace:** `chroma-memory`
**Helm release:** `chroma-memory` (in `default` namespace)
**Domain:** `chroma-memory.frangulov.dev` (TLS via cert-manager/lets-encrypt)
**Docker Hub:** `docker.io/sfrangulov/chroma-memory-mcp`

## Prerequisites

- Docker Desktop with `credsStore: desktop` (auto-login to Docker Hub)
- `kubectl` configured for the MicroK8s cluster
- `helm` v3+
- Node.js 20+ (for running tests locally)

## Full Release Cycle

### 1. Run tests

```bash
npm test
```

All 49 tests must pass before building.

### 2. Bump version

Update version in three places:

```bash
# package.json
"version": "X.Y.Z"

# helm/chroma-memory-mcp/Chart.yaml
version: X.Y.Z
appVersion: "X.Y.Z"

# helm/chroma-memory-mcp/values.yaml
mcp:
  image:
    tag: "X.Y.Z"
```

### 3. Build Docker image

```bash
docker build --platform linux/amd64 -t sfrangulov/chroma-memory-mcp:X.Y.Z -t sfrangulov/chroma-memory-mcp:latest .
```

The `--platform linux/amd64` flag is required — the cluster runs amd64.

### 4. Push to Docker Hub

```bash
docker push sfrangulov/chroma-memory-mcp:X.Y.Z
docker push sfrangulov/chroma-memory-mcp:latest
```

Credentials are stored in Docker Desktop keychain. No manual login needed.

### 5. Deploy to Kubernetes

```bash
helm upgrade chroma-memory ./helm/chroma-memory-mcp \
  --namespace default \
  --set mcp.image.tag=X.Y.Z \
  --set secrets.googleApiKey=<GEMINI_API_KEY> \
  --set secrets.googleClientId=<GOOGLE_CLIENT_ID> \
  --set secrets.googleClientSecret=<GOOGLE_CLIENT_SECRET> \
  --set chromadb.persistence.storageClass=microk8s-hostpath
```

**Important flags:**
- `--namespace default` — Helm release lives in default namespace (resources created in `chroma-memory`)
- `chromadb.persistence.storageClass=microk8s-hostpath` — must match existing PVC, omitting this causes upgrade failure

### 6. Verify deployment

```bash
# Watch rollout
kubectl rollout status deployment/chroma-memory-chroma-memory-mcp-mcp -n chroma-memory --timeout=90s

# Check all pods are running
kubectl get pods -n chroma-memory

# Health check through ingress
curl -sk https://chroma-memory.frangulov.dev/health
# Expected: {"status":"ok"}

# Redis connectivity
kubectl exec -n chroma-memory deployment/chroma-memory-chroma-memory-mcp-redis -- redis-cli ping
# Expected: PONG

# MCP server logs
kubectl logs -n chroma-memory deployment/chroma-memory-chroma-memory-mcp-mcp --tail=20
```

## Quick Upgrade (image only)

When only application code changed (no Helm chart changes):

```bash
npm test
docker build --platform linux/amd64 -t sfrangulov/chroma-memory-mcp:X.Y.Z .
docker push sfrangulov/chroma-memory-mcp:X.Y.Z
helm upgrade chroma-memory ./helm/chroma-memory-mcp \
  --namespace default \
  --set mcp.image.tag=X.Y.Z \
  --reuse-values
```

`--reuse-values` carries forward all previous secrets and settings.

## First-Time Setup

If deploying to a fresh cluster:

```bash
# 1. Create namespace
kubectl create namespace chroma-memory

# 2. Install Helm chart
helm install chroma-memory ./helm/chroma-memory-mcp \
  --namespace default \
  --set mcp.image.tag=0.3.0 \
  --set secrets.googleApiKey=<KEY> \
  --set secrets.googleClientId=<ID> \
  --set secrets.googleClientSecret=<SECRET> \
  --set chromadb.persistence.storageClass=<STORAGE_CLASS>

# 3. Point DNS to cluster ingress IP
# chroma-memory.frangulov.dev -> cluster external IP
```

Requirements on cluster:
- nginx ingress controller (`className: public`)
- cert-manager with `lets-encrypt` ClusterIssuer

## Environment Variables

### Required for production

| Variable | Source | Purpose |
|----------|--------|---------|
| `GOOGLE_API_KEY` | Secret | Gemini embedding API key |
| `GOOGLE_CLIENT_ID` | Secret | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Secret | Google OAuth2 client secret |
| `MCP_BASE_URL` | Computed from ingress | Public URL for OAuth callbacks |

### Auto-configured by Helm

| Variable | Value | Purpose |
|----------|-------|---------|
| `CHROMA_URL` | `http://<release>-chromadb:8000` | Internal ChromaDB endpoint |
| `REDIS_URL` | `redis://<release>-redis:6379` | Session storage (when redis.enabled) |
| `MCP_PORT` | `3000` | Server port |
| `MCP_HOST` | `0.0.0.0` | Bind address |
| `CHROMA_COLLECTION` | `memories` | ChromaDB collection name |

## Rollback

```bash
# List revisions
helm history chroma-memory -n default

# Rollback to previous revision
helm rollback chroma-memory <REVISION> -n default
```

## Troubleshooting

### Pod stuck in Pending

```bash
kubectl describe pod -n chroma-memory <POD_NAME>
```

Usually caused by insufficient CPU. The cluster has limited resources — ensure old broken pods are cleaned up:

```bash
kubectl delete pod -n chroma-memory <BROKEN_POD>
```

### PVC upgrade failure

Error: `spec is immutable after creation except resources.requests`

This happens when `storageClass` doesn't match existing PVC. Always pass `--set chromadb.persistence.storageClass=microk8s-hostpath`.

### Data protection

ChromaDB PVC has `helm.sh/resource-policy: keep` annotation — Helm will not delete it even on `helm uninstall`. Additionally, the PV reclaim policy should be set to `Retain`:

```bash
# Check current reclaim policy
kubectl get pv | grep chroma

# Set to Retain (prevents data loss if PVC is deleted)
kubectl patch pv <PV_NAME> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

**WARNING:** Never delete the `chroma-memory` namespace — this deletes ALL resources including PVC/PV and causes permanent data loss. If the namespace disappears, the PV data may still exist on disk at `/var/snap/microk8s/common/default-storage/` if reclaim policy was `Retain`.

### Namespace deleted

If `chroma-memory` namespace disappears:

```bash
kubectl create namespace chroma-memory
helm upgrade chroma-memory ./helm/chroma-memory-mcp --namespace default --reuse-values
```

**Note:** This creates a new empty PVC. Previous data is lost unless PV had `Retain` policy.

### Gemini embedding warning in logs

```
Embedding function google-generative-ai failed to build with config: [object Object]
```

This is a ChromaDB warning about stored config — it tries to read `GEMINI_API_KEY` env var for persisted collection config. Functionally harmless: the embedding function receives `apiKey` directly via constructor and works correctly.

### Redis CreateContainerConfigError

Redis image runs as root by default. The Helm chart sets `runAsUser: 999` to satisfy `runAsNonRoot`. If this error appears, ensure the redis-deployment template has `runAsUser: 999`.

### MCP CreateContainerConfigError

The Node.js image uses non-numeric user `node`. The Helm chart sets `runAsUser: 1000` to satisfy `runAsNonRoot`. If this error appears, ensure the mcp-deployment template has `runAsUser: 1000`.

## Local Development

```bash
# Start ChromaDB + Redis + MCP locally
docker compose up -d

# Or without Docker (ChromaDB must be running separately)
export CHROMA_URL=http://localhost:8000
npm start
```

## Architecture Notes

- Helm release is in `default` namespace, resources are in `chroma-memory` namespace
- NetworkPolicy restricts ChromaDB access to only MCP pods
- Ingress has `proxy-buffering: off` for MCP Streamable HTTP transport
- `NODE_ENV=production` enforces OAuth requirements — dev mode allows anonymous access
- Redis enables distributed sessions for multi-replica scaling (currently 1 replica)
