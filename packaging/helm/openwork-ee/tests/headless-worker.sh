#!/usr/bin/env bash
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
review_dir="$(mktemp -d)"
trap 'rm -rf "$review_dir"' EXIT
helm template review "$chart_dir" > "$review_dir/default.yaml"
if rg -q '^# Source: .*templates/headless-worker.yaml' "$review_dir/default.yaml"; then
  echo 'Worker must be disabled by default' >&2; exit 1
fi
helm template review "$chart_dir" --set headlessWorker.enabled=true --set headlessWorker.replicaCount=2 --set image.tag=review > "$review_dir/enabled.yaml"
node --input-type=module - "$review_dir/enabled.yaml" <<'JS'
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
const documents=readFileSync(process.argv[2],"utf8").split(/\n---\n/)
const worker=documents.find(doc=>doc.includes("templates/headless-worker.yaml"))
assert.ok(worker,"Worker deployment exists when explicitly enabled")
for(const required of ["kind: Deployment","replicas: 2","automountServiceAccountToken: false","runAsNonRoot: true","readOnlyRootFilesystem: true","allowPrivilegeEscalation: false",'drop: ["ALL"]',"emptyDir:","sizeLimit: 2Gi","name: DATABASE_URL","name: DEN_DB_ENCRYPTION_KEY","secretKeyRef:","configMapRef:","readinessProbe:","livenessProbe:","path: /health","name: CLOUD_RUNTIME_PROVIDER",'value: "stub"'])assert.ok(worker.includes(required),required)
for(const denied of ["persistentVolumeClaim:","DAYTONA_API_KEY","FREESTYLE_API_KEY","GITHUB_CLIENT_SECRET","containerPort: 8788"])assert.ok(!worker.includes(denied),denied)
assert.ok(!documents.some(doc=>/kind: (Service|Ingress)/.test(doc) && doc.includes("headless-worker")),"Worker is private")
assert.match(worker,/openwork-den-headless:review/,"Worker follows the existing release image tag")
console.log("Cloud worker chart: default-off, private, scoped secrets, probes, replicas, and no durable local volume verified")
JS
