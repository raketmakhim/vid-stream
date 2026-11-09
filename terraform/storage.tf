# ---------- Storage: private bucket, only CloudFront can read ----------

resource "aws_s3_bucket" "site" {
  bucket = "${local.name}-${data.aws_caller_identity.me.account_id}-${var.region}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = { ArnEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
    }]
  })
}

# Every file in ./web (index.html, style.css, app.js) is uploaded as-is.
locals {
  mime = { html = "text/html", css = "text/css", js = "text/javascript" }
}

resource "aws_s3_object" "web" {
  for_each      = fileset("${path.module}/../web", "*")
  bucket        = aws_s3_bucket.site.id
  key           = each.value
  source        = "${path.module}/../web/${each.value}"
  etag          = filemd5("${path.module}/../web/${each.value}")
  content_type  = lookup(local.mime, regex("[^.]+$", each.value), "application/octet-stream")
  cache_control = "no-cache"
}

# keeps the already-deployed index.html from being deleted and re-created
moved {
  from = aws_s3_object.index
  to   = aws_s3_object.web["index.html"]
}

# ---------- CloudFront signing key (private half goes to SSM) ----------

resource "tls_private_key" "cf" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "cf" {
  name        = local.name
  encoded_key = tls_private_key.cf.public_key_pem
}

resource "aws_cloudfront_key_group" "cf" {
  name  = local.name
  items = [aws_cloudfront_public_key.cf.id]
}

resource "random_password" "hmac" {
  length  = 48
  special = false
}

# Placeholder only. Change it in the console (Systems Manager > Parameter Store);
# ignore_changes stops Terraform from ever overwriting the real password.
# The login Lambda refuses to accept "CHANGE_ME" itself.
resource "aws_ssm_parameter" "password" {
  name  = "${local.params}/password"
  type  = "SecureString"
  value = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "cf_private_key" {
  name  = "${local.params}/cf-private-key"
  type  = "SecureString"
  value = tls_private_key.cf.private_key_pem
}

resource "aws_ssm_parameter" "hmac" {
  name  = "${local.params}/hmac-secret"
  type  = "SecureString"
  value = random_password.hmac.result
}
