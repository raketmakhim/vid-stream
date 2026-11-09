# Upload ./videos (mp4, .vtt, library.json) to the site bucket with correct content types.
$ErrorActionPreference = 'Stop'

function Run { & aws @args; if ($LASTEXITCODE) { throw "aws failed: $args" } }

# Browsers only read WebVTT, so turn each .srt into a .vtt first (commas in timestamps become dots).
# shortcut: assumes UTF-8 subtitles; re-save the .srt as UTF-8 if accents come out garbled.
Get-ChildItem videos -Filter *.srt | ForEach-Object {
    $vtt = [IO.Path]::ChangeExtension($_.FullName, 'vtt')
    $text = (Get-Content $_.FullName -Raw -Encoding UTF8) -replace '(\d\d:\d\d:\d\d),(\d{3})', '$1.$2'
    [IO.File]::WriteAllText($vtt, "WEBVTT`n`n$text", (New-Object Text.UTF8Encoding $false))
}

$bucket = terraform -chdir=terraform output -raw bucket
if ($LASTEXITCODE) { throw 'terraform output failed - has it been applied?' }

$dest = "s3://$bucket/videos"
Run s3 sync videos $dest --exclude '*.vtt' --exclude '*.json' --exclude '*.srt'
Run s3 sync videos $dest --exclude '*' --include '*.vtt' --content-type 'text/vtt'
Run s3 sync videos $dest --exclude '*' --include '*.json' --exclude 'library.example.json' --content-type 'application/json'
