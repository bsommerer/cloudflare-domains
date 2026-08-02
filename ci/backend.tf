# Wird von den reusable Workflows in die Engine kopiert, bevor `terraform init`
# läuft – im Repo selbst liegt bewusst KEIN backend-Block, damit die Engine
# auch als Modul und lokal ohne Remote-State nutzbar bleibt.
#
# Cloudflare R2 ist S3-kompatibel. Es fehlen hier drei Werte, weil sie
# deployment-spezifisch sind:
#   bucket, key   -> per `terraform init -backend-config=...`
#   endpoint      -> per Umgebungsvariable AWS_ENDPOINT_URL_S3
terraform {
  backend "s3" {
    region = "auto"

    # R2 kennt weder STS noch die EC2-Metadata-API und rechnet die
    # S3-Prüfsummen anders ab.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true

    # State-Locking über eine Lock-Datei im Bucket (bedingte Writes), statt
    # über DynamoDB. Braucht Terraform >= 1.10.
    use_lockfile = true
  }
}
