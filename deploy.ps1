# Init (only if needed) and apply the Terraform in ./terraform.
# `terraform apply` shows the plan and waits for you to type yes or no.
$ErrorActionPreference = 'Stop'

function Run { & $args[0] $args[1..($args.Count - 1)]; if ($LASTEXITCODE) { throw "failed: $args" } }

aws sts get-caller-identity --query Account --output text | Out-Null
if ($LASTEXITCODE) { throw 'Not signed in to AWS in this terminal.' }

if (-not (Test-Path terraform\.terraform\providers)) {
    Run terraform -chdir=terraform init
}

Run terraform -chdir=terraform apply

"`nSite: " + (terraform -chdir=terraform output -raw url)
"If this is the first deploy, set /vidstream/password in the console (Systems Manager > Parameter Store), then run ./upload.ps1"
