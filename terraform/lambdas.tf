# ---------- Lambdas (one zip, two handlers) ----------

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/lambda.zip"
  excludes    = ["lib.test.js"]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "login" {
  name               = "${local.name}-login"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role" "sync" {
  name               = "${local.name}-sync"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "login" {
  role = aws_iam_role.login.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "ssm:GetParameters"
      Resource = [
        aws_ssm_parameter.password.arn,
        aws_ssm_parameter.cf_private_key.arn,
        aws_ssm_parameter.hmac.arn,
      ]
    }]
  })
}

resource "aws_iam_role_policy" "sync" {
  role = aws_iam_role.sync.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ssm:GetParameters", Resource = aws_ssm_parameter.hmac.arn },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.connections.arn
      },
      {
        Effect   = "Allow"
        Action   = "execute-api:ManageConnections"
        Resource = "${aws_apigatewayv2_api.ws.execution_arn}/${local.stage}/POST/@connections/*"
      },
    ]
  })
}

resource "aws_lambda_function" "login" {
  function_name    = "${local.name}-login"
  role             = aws_iam_role.login.arn
  runtime          = "nodejs24.x"
  handler          = "login.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      PARAM_PREFIX = local.params
      KEY_PAIR_ID  = aws_cloudfront_public_key.cf.id
      WS_URL       = aws_apigatewayv2_stage.ws.invoke_url
    }
  }
}

resource "aws_lambda_function" "sync" {
  function_name    = "${local.name}-sync"
  role             = aws_iam_role.sync.arn
  runtime          = "nodejs24.x"
  handler          = "sync.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      PARAM_PREFIX = local.params
      TABLE        = aws_dynamodb_table.connections.name
    }
  }
}

# shortcut: login URL is public (auth NONE), so it can be hit without CloudFront.
# The password still gates it; upgrade to CloudFront OAC for Lambda if that matters.
resource "aws_lambda_function_url" "login" {
  function_name      = aws_lambda_function.login.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "login_url" {
  statement_id           = "AllowFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.login.function_name
  principal              = "*"
  function_url_auth_type = "NONE"

  # Lambda rejects parallel edits to one function's policy (409), so run these one after another.
  depends_on = [aws_lambda_function_url.login]
}

resource "aws_lambda_permission" "login_invoke" {
  statement_id             = "AllowInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.login.function_name
  principal                = "*"
  invoked_via_function_url = true
  depends_on               = [aws_lambda_permission.login_url]
}
