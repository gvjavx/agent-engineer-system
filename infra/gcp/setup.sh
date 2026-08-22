#!/usr/bin/env bash
# One-time GCP provisioning: static IP, firewall, VM, and the Workload
# Identity Federation wiring GitHub Actions needs to SSH-deploy without any
# stored secret. Safe to re-run — every gcloud call here is idempotent
# (checks before create).
#
# Usage:
#   VM_MACHINE_TYPE=e2-small ./infra/gcp/setup.sh   # cheaper VM
#   ./infra/gcp/setup.sh                            # defaults to e2-medium
#
# Requires: gcloud CLI authenticated (gcloud auth login) against the project
# you want to deploy into, and a filled-in .env at the repo root — its
# contents become the VM's runtime secret (DOMAIN gets overwritten below
# with the sslip.io address derived from the static IP GCP hands out).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ ! -f .env ]; then
  echo ".env not found at repo root — cp .env.example .env and fill it in first." >&2
  exit 1
fi

PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
if [ -z "$PROJECT_ID" ]; then
  echo "No active gcloud project. Run: gcloud config set project <id>" >&2
  exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

REGION="asia-southeast2"
ZONE="asia-southeast2-a"
VM_NAME="agent-engineer-vm"
VM_MACHINE_TYPE="${VM_MACHINE_TYPE:-e2-medium}"
STATIC_IP_NAME="agent-engineer-ip"
RUNTIME_SA_NAME="agent-engineer-runtime"
DEPLOY_SA_NAME="agent-engineer-deployer"
SECRET_NAME="agent-engineer-env"
WIF_POOL="github-pool"
WIF_PROVIDER="github-provider"
GITHUB_REPO="$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')"

RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA_EMAIL="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project:      $PROJECT_ID ($PROJECT_NUMBER)"
echo "Repo:         $GITHUB_REPO"
echo "VM:           $VM_NAME ($VM_MACHINE_TYPE, $ZONE)"
echo

echo "== Enabling APIs =="
gcloud services enable \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT_ID"

echo "== Static IP =="
if ! gcloud compute addresses describe "$STATIC_IP_NAME" --region "$REGION" --project "$PROJECT_ID" &>/dev/null; then
  gcloud compute addresses create "$STATIC_IP_NAME" --region "$REGION" --project "$PROJECT_ID"
fi
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --region "$REGION" --project "$PROJECT_ID" --format='value(address)')"
SSLIP_DOMAIN="$(echo "$STATIC_IP" | tr '.' '-').sslip.io"
echo "Static IP: $STATIC_IP -> $SSLIP_DOMAIN"

echo "== Firewall =="
if ! gcloud compute firewall-rules describe agent-engineer-allow-web --project "$PROJECT_ID" &>/dev/null; then
  gcloud compute firewall-rules create agent-engineer-allow-web \
    --project "$PROJECT_ID" --network default --direction INGRESS \
    --action ALLOW --rules tcp:80,tcp:443 \
    --source-ranges 0.0.0.0/0 --target-tags agent-engineer-vm
fi
if ! gcloud compute firewall-rules describe agent-engineer-allow-iap-ssh --project "$PROJECT_ID" &>/dev/null; then
  # 35.235.240.0/20 is Google's IAP TCP forwarding range — no SSH port open to the public internet.
  gcloud compute firewall-rules create agent-engineer-allow-iap-ssh \
    --project "$PROJECT_ID" --network default --direction INGRESS \
    --action ALLOW --rules tcp:22 \
    --source-ranges 35.235.240.0/20 --target-tags agent-engineer-vm
fi

echo "== Runtime service account (VM identity, reads the env secret) =="
if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" --project "$PROJECT_ID" &>/dev/null; then
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --project "$PROJECT_ID" --display-name "agent-engineer-system VM runtime"
fi

echo "== Env secret =="
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT
grep -v '^DOMAIN=' .env > "$TMP_ENV" || true
echo "DOMAIN=${SSLIP_DOMAIN}" >> "$TMP_ENV"

if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" &>/dev/null; then
  gcloud secrets create "$SECRET_NAME" --project "$PROJECT_ID" --replication-policy automatic
fi
gcloud secrets versions add "$SECRET_NAME" --project "$PROJECT_ID" --data-file "$TMP_ENV"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT_ID" \
  --member "serviceAccount:${RUNTIME_SA_EMAIL}" --role roles/secretmanager.secretAccessor >/dev/null

echo "== Deploy service account (impersonated by GitHub Actions via WIF, no key file) =="
if ! gcloud iam service-accounts describe "$DEPLOY_SA_EMAIL" --project "$PROJECT_ID" &>/dev/null; then
  gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
    --project "$PROJECT_ID" --display-name "agent-engineer-system GitHub Actions deployer"
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" --role roles/compute.osAdminLogin >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" --role roles/iap.tunnelResourceAccessor >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" --role roles/compute.viewer >/dev/null

echo "== Workload Identity Federation (GitHub Actions <-> deploy SA, restricted to $GITHUB_REPO) =="
if ! gcloud iam workload-identity-pools describe "$WIF_POOL" --project "$PROJECT_ID" --location global &>/dev/null; then
  gcloud iam workload-identity-pools create "$WIF_POOL" \
    --project "$PROJECT_ID" --location global --display-name "GitHub Actions"
fi
if ! gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --project "$PROJECT_ID" --location global --workload-identity-pool "$WIF_POOL" &>/dev/null; then
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --project "$PROJECT_ID" --location global --workload-identity-pool "$WIF_POOL" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "attribute.repository == '${GITHUB_REPO}'"
fi
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA_EMAIL" \
  --project "$PROJECT_ID" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

echo "== VM =="
if ! gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" &>/dev/null; then
  gcloud compute instances create "$VM_NAME" \
    --project "$PROJECT_ID" --zone "$ZONE" \
    --machine-type "$VM_MACHINE_TYPE" \
    --image-family ubuntu-2204-lts --image-project ubuntu-os-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-balanced \
    --address "$STATIC_IP" \
    --tags agent-engineer-vm \
    --service-account "$RUNTIME_SA_EMAIL" --scopes cloud-platform \
    --metadata enable-oslogin=TRUE,github-repo="$GITHUB_REPO",secret-name="$SECRET_NAME",project-id="$PROJECT_ID" \
    --metadata-from-file startup-script=infra/gcp/startup-script.sh
else
  echo "VM already exists — skipping create. To pick up a new machine type, resize manually:"
  echo "  gcloud compute instances set-machine-type $VM_NAME --zone $ZONE --machine-type <type>"
fi

echo
echo "Done. Next steps:"
echo "1. Wait ~1-2 min for the VM to boot and finish its first deploy (installs Docker, clones the repo, brings up docker compose)."
echo "2. Point the Meta webhook Callback URL to: https://${SSLIP_DOMAIN}/webhook"
echo "3. Add these as GitHub Actions repo *variables* (Settings > Secrets and variables > Actions > Variables), not secrets — none of them are sensitive on their own:"
echo "   GCP_PROJECT_ID     = $PROJECT_ID"
echo "   GCP_WIF_PROVIDER   = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"
echo "   GCP_DEPLOY_SA      = $DEPLOY_SA_EMAIL"
echo "   GCP_ZONE           = $ZONE"
echo "   GCP_VM_NAME        = $VM_NAME"
echo "4. Push to main — .github/workflows/deploy.yml handles the rest from there."
