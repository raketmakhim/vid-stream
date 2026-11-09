output "url" {
  description = "Open this in the browser"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "bucket" {
  value = aws_s3_bucket.site.id
}
