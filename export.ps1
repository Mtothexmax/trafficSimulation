# export.ps1 - Static export for GitHub Pages (trafficSimulation)
# Builds the SvelteKit app with adapter-static into docs/ so it can be served
# from https://mtothexmax.github.io/trafficSimulation/.
#
# vite.config.ts switches to the export settings itself when EXPORT_BASE_PATH is set
# (base path, 404.html as SPA fallback). Nothing in the project is rewritten, so an
# aborted build leaves no traces.
#
# Sample networks (static/samples) and controller programs are NOT exported: they are
# not part of the repository and must not be published.
#
# Usage (from the project root):
#   powershell -ExecutionPolicy Bypass -File .\export.ps1
#   .\export.ps1 -BasePath "/trafficSimulation"
param(
    [string]$BasePath = "/trafficSimulation"
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "=== trafficSimulation Export fuer GitHub Pages ===" -ForegroundColor Cyan
Write-Host "Base path: $BasePath"
Write-Host "Output:    docs/"
Write-Host ""

# 1. Dependencies
if (-not (Test-Path 'node_modules/@sveltejs/adapter-static')) {
    Write-Host "[1/5] Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} else {
    Write-Host "[1/5] Dependencies already installed" -ForegroundColor Green
}

$env:EXPORT_BASE_PATH = $BasePath
try {
    # 2. Build
    Write-Host "[2/5] Building static export..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    if (-not (Test-Path 'build/404.html')) { throw "build/404.html missing - was adapter-static used?" }

    # 3. Deploy to docs/
    Write-Host "[3/5] Deploying to docs/..." -ForegroundColor Yellow
    if (Test-Path 'docs') {
        Remove-Item 'docs/*' -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item 'docs/.nojekyll' -Force -ErrorAction SilentlyContinue
    } else {
        New-Item -ItemType Directory -Path 'docs' | Out-Null
    }
    Copy-Item 'build/*' 'docs/' -Recurse -Force

    # 4. Nothing that is not ours to publish: sample networks, controller programs, supply files
    Write-Host "[4/5] Removing files that must not be published..." -ForegroundColor Yellow
    foreach ($path in @('docs/samples', 'docs/__tmp')) {
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }
    $forbidden = Get-ChildItem 'docs' -Recurse -File | Where-Object { $_.Extension -match '^\.(exe|vsg|vag|inpx|sig|wtt)$' }
    if ($forbidden) {
        $forbidden | Remove-Item -Force
        Write-Host ("      removed: " + (($forbidden | ForEach-Object Name) -join ', ')) -ForegroundColor DarkYellow
    }

    # The app renders entirely in the browser (ssr = false): the fallback page is the app.
    # index.html serves the start URL, 404.html makes deep links work on GitHub Pages.
    Copy-Item 'docs/404.html' 'docs/index.html' -Force

    # 5. Disable Jekyll: without this, GitHub Pages ignores the _app/ folder
    Write-Host "[5/5] Writing .nojekyll" -ForegroundColor Yellow
    New-Item -ItemType File -Path 'docs/.nojekyll' -Force | Out-Null

    $size = (Get-ChildItem 'docs' -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host ""
    Write-Host "=== Done! ===" -ForegroundColor Cyan
    Write-Host ("Deployed to docs/ ({0:N1} MB)" -f $size) -ForegroundColor Green
    Write-Host "Live after push: https://mtothexmax.github.io$BasePath/" -ForegroundColor Green
} finally {
    Remove-Item Env:EXPORT_BASE_PATH -ErrorAction SilentlyContinue
    Remove-Item 'build' -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Cleaned up" -ForegroundColor DarkGray
}
