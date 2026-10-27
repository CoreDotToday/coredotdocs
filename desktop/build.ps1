param(
    [ValidateSet('win', 'dir')]
    [string]$Target = 'win',
    [string]$OutDir = $(if ($env:OUT_DIR) { $env:OUT_DIR } else { 'dist' })
)

# Native Windows build: Python backend + Next standalone + Electron/NSIS.
$ErrorActionPreference = 'Stop'
$desktopRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $desktopRoot
$originalLocation = Get-Location
$originalApiUrl = $env:NEXT_PUBLIC_API_URL
$originalSigning = $env:CSC_IDENTITY_AUTO_DISCOVERY

function Invoke-BuildCommand {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Reset-ResourceDirectory {
    param([string]$Name)
    Invoke-BuildCommand 'node' @((Join-Path $desktopRoot 'scripts/reset-resource.cjs'), $Name)
}

function Copy-BuildTree {
    param([string]$Source, [string]$Destination)
    # Copy ordinary resource trees; Next dependencies use copy-standalone.cjs.
    Invoke-BuildCommand 'node' @('-e', "require('node:fs').cpSync(process.argv[1], process.argv[2], {recursive:true,dereference:true})", $Source, $Destination)
}

try {
    foreach ($command in @('node', 'pnpm', 'uv', 'git')) { Get-Command $command -ErrorAction Stop | Out-Null }
    $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
    if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }

    Write-Host '[1/3] Building Python backend'
    Set-Location (Join-Path $repoRoot 'backend')
    $pythonVersion = (Get-Content -LiteralPath (Join-Path $desktopRoot 'scripts/python-version.txt') -Raw).Trim()
    Invoke-BuildCommand 'uv' @('sync', '--frozen', '--managed-python', '--python', $pythonVersion)
    $pyinstallerArgs = @(
        'run', '--frozen', 'pyinstaller', '--noconfirm', '--clean', '--onedir', '--name', 'editor-server',
        '--paths', '.',
        '--hidden-import', 'app.main', '--hidden-import', 'app.mcp_stdio',
        '--hidden-import', 'uvicorn.logging', '--hidden-import', 'uvicorn.loops.auto', '--hidden-import', 'uvicorn.loops.asyncio',
        '--hidden-import', 'uvicorn.protocols.http.auto', '--hidden-import', 'uvicorn.protocols.http.h11_impl',
        '--hidden-import', 'uvicorn.protocols.http.httptools_impl', '--hidden-import', 'uvicorn.protocols.websockets.auto',
        '--hidden-import', 'uvicorn.lifespan.on', '--hidden-import', 'uvicorn.lifespan.off',
        '--collect-all', 'jsonschema', '--collect-all', 'jsonschema_specifications',
        '--collect-submodules', 'sqlalchemy.dialects.sqlite',
        # Desktop uses SQLite. Keep SQLAlchemy's PG types used by shared models,
        # but do not redistribute the optional native PostgreSQL drivers.
        '--exclude-module', 'psycopg', '--exclude-module', 'psycopg_binary', '--exclude-module', 'psycopg_c',
        '--exclude-module', 'psycopg2', '--exclude-module', 'psycopg2cffi', '--exclude-module', 'asyncpg', '--exclude-module', 'pg8000',
        '--add-data', 'app/engine/rhwp_convert.mjs:app/engine',
        'desktop_entry.py'
    )
    Invoke-BuildCommand 'uv' $pyinstallerArgs
    Invoke-BuildCommand 'uv' @('run', '--frozen', 'python', (Join-Path $desktopRoot 'scripts/collect-python-licenses.py'), '--write')
    $backendResources = Reset-ResourceDirectory 'backend'
    Copy-BuildTree (Join-Path $repoRoot 'backend/dist/editor-server') (Join-Path $backendResources 'editor-server')
    $skillResources = Reset-ResourceDirectory 'skills'
    Copy-BuildTree (Join-Path $repoRoot 'skills') $skillResources

    Write-Host '[2/3] Building frontend'
    Set-Location (Join-Path $repoRoot 'frontend')
    Invoke-BuildCommand 'pnpm' @('install', '--frozen-lockfile')
    $env:NEXT_PUBLIC_API_URL = ''
    Invoke-BuildCommand 'pnpm' @('build')
    $webResources = Reset-ResourceDirectory 'web'
    Invoke-BuildCommand 'node' @((Join-Path $desktopRoot 'scripts/copy-standalone.cjs'), (Join-Path $repoRoot 'frontend/.next/standalone'), $webResources)
    Copy-BuildTree (Join-Path $repoRoot 'frontend/.next/static') (Join-Path $webResources '.next/static')
    Copy-BuildTree (Join-Path $repoRoot 'frontend/public') (Join-Path $webResources 'public')

    Write-Host '[3/3] Packaging Electron'
    if (-not (Test-Path -LiteralPath (Join-Path $desktopRoot 'build/icon.png'))) {
        Invoke-BuildCommand 'node' @((Join-Path $desktopRoot 'scripts/make-icon.mjs'), (Join-Path $desktopRoot 'build/icon.png'))
    }
    Set-Location $desktopRoot
    Invoke-BuildCommand 'pnpm' @('install', '--frozen-lockfile')
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $builderArgs = @('exec', 'electron-builder', '--win', '--x64', "--config.directories.output=$OutDir")
    if ($Target -eq 'dir') { $builderArgs += '--dir' }
    Invoke-BuildCommand 'pnpm' $builderArgs
    Write-Host "Build complete: $(Join-Path $desktopRoot $OutDir)"
} finally {
    $env:NEXT_PUBLIC_API_URL = $originalApiUrl
    $env:CSC_IDENTITY_AUTO_DISCOVERY = $originalSigning
    Set-Location $originalLocation
}
