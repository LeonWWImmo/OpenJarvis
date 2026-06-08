param(
    [Parameter(Mandatory = $true)]
    [string]$ServerUrl,
    [switch]$Desktop
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot "frontend"
$envFile = Join-Path $frontendDir ".env.local"
$normalizedUrl = $ServerUrl.TrimEnd("/")

if ($normalizedUrl -notmatch "^https?://") {
    throw "ServerUrl must start with http:// or https://"
}

@"
VITE_REMOTE_CLIENT=true
VITE_API_URL=$normalizedUrl
"@ | Set-Content -LiteralPath $envFile -Encoding utf8

Push-Location $frontendDir
try {
    if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
        npm install
    }

    if ($Desktop) {
        npm run tauri dev
    } else {
        npm run dev
    }
} finally {
    Pop-Location
}
