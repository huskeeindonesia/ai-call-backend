# Cloud Run Setup (us-central1) + Auto Deploy from GitHub

## Status saat ini
- Workflow GitHub Actions sudah disiapkan di:
  - `.github/workflows/deploy-cloud-run.yml`
- Region default: `us-central1`
- Service default: `ai-call-backend`

## Prasyarat
1. Punya project GCP aktif
2. Billing aktif (free-tier Cloud Run tetap perlu billing account)
3. Repo GitHub untuk project ini
4. Workload Identity Federation (recommended, tanpa service account key static)

## 1) Enable APIs
```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com cloudbuild.googleapis.com
```

## 2) Buat Artifact Registry (sekali)
```bash
gcloud artifacts repositories create ai-call-backend \
  --repository-format=docker \
  --location=us-central1 \
  --description="Docker repo for ai-call-backend"
```

## 3) Setup Workload Identity Federation (GitHub OIDC)
Ikuti panduan resmi Google untuk membuat:
- Workload Identity Pool + Provider
- Service Account deployer
- IAM binding agar GitHub repo Anda bisa impersonate SA

Lalu set GitHub Secrets:
- `GCP_PROJECT_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT_EMAIL`

## 4) Push ke GitHub
Setelah secrets terisi, setiap `push` ke `main/master` akan:
1. build image
2. push ke Artifact Registry
3. deploy ke Cloud Run (us-central1)

## Notes keamanan
- Jangan commit `.env`
- Simpan env runtime di Cloud Run (Secrets Manager/env vars)
- Untuk endpoint webhook provider, gunakan verifikasi signature
