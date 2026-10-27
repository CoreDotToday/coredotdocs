param(
    [string]$InstallerPath,
    [string]$NodePath = 'node',
    [switch]$Execute
)

# Run only after coordinating with the owner of any open coredotdocs windows.
# Without -Execute this script prints a read-only plan. The installed app is
# exercised with smoke-app-win.cjs, which always uses its own user-data directory.
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $InstallerPath) { $InstallerPath = Join-Path $desktopRoot "dist/coredotdocs-$($package.version)-setup.exe" }
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)

function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Same-Version([string]$Actual, [string]$Expected) {
    $left = [Version]$Actual
    $right = [Version]$Expected
    return ($left.Major -eq $right.Major -and $left.Minor -eq $right.Minor -and [Math]::Max(0, $left.Build) -eq [Math]::Max(0, $right.Build) -and [Math]::Max(0, $left.Revision) -eq [Math]::Max(0, $right.Revision))
}
function Same-Json($Left, $Right) { return (($Left | ConvertTo-Json -Depth 40 -Compress) -ceq ($Right | ConvertTo-Json -Depth 40 -Compress)) }
function Write-Json([string]$Path, $Value) { $Value | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $Path -Encoding UTF8 }
function Assert-Contained([string]$Root, [string]$Target) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $targetPath = [IO.Path]::GetFullPath($Target)
    Assert-True ($targetPath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) "Path is outside the test root: $targetPath"
}

function Get-AppGuid([string]$AppId) {
    # electron-builder's UUID v5 namespace (NsisTarget.js).
    $hex = '50e065bc313411e69bab38c9862bdaf3'
    [byte[]]$namespace = for ($index = 0; $index -lt 32; $index += 2) { [Convert]::ToByte($hex.Substring($index, 2), 16) }
    $sha = [Security.Cryptography.SHA1]::Create()
    try { $bytes = $sha.ComputeHash([byte[]]($namespace + [Text.Encoding]::UTF8.GetBytes($AppId))) } finally { $sha.Dispose() }
    $bytes[6] = ($bytes[6] -band 15) -bor 80
    $bytes[8] = ($bytes[8] -band 63) -bor 128
    $value = -join ($bytes[0..15] | ForEach-Object { $_.ToString('x2') })
    return '{0}-{1}-{2}-{3}-{4}' -f $value.Substring(0,8), $value.Substring(8,4), $value.Substring(12,4), $value.Substring(16,4), $value.Substring(20,12)
}

function Open-Registry([string]$Hive, [string]$View) {
    $hiveId = if ($Hive -eq 'HKCU') { [Microsoft.Win32.RegistryHive]::CurrentUser } else { [Microsoft.Win32.RegistryHive]::LocalMachine }
    $viewId = if ($View -eq '64') { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
    return [Microsoft.Win32.RegistryKey]::OpenBaseKey($hiveId, $viewId)
}

function Read-Tree($Base, [string]$KeyPath) {
    $key = $Base.OpenSubKey($KeyPath)
    if ($null -eq $key) { return [ordered]@{ exists = $false; values = @(); children = @() } }
    try {
        $values = @($key.GetValueNames() | Sort-Object | ForEach-Object {
            [ordered]@{ name = $_; kind = [string]$key.GetValueKind($_); data = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        })
        $children = @($key.GetSubKeyNames() | Sort-Object | ForEach-Object { [ordered]@{ name = $_; tree = Read-Tree $Base ($KeyPath + '\' + $_) } })
        return [ordered]@{ exists = $true; values = $values; children = $children }
    } finally { $key.Dispose() }
}

function Read-Value($Base, [string]$KeyPath, [string]$Name) {
    $key = $Base.OpenSubKey($KeyPath)
    if ($null -eq $key) { return [ordered]@{ exists = $false } }
    try {
        if ($key.GetValueNames() -notcontains $Name) { return [ordered]@{ exists = $false } }
        return [ordered]@{ exists = $true; kind = [string]$key.GetValueKind($Name); data = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    } finally { $key.Dispose() }
}

function Write-Value($Key, [string]$Name, $Value) {
    $kind = [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], $Value.kind)
    $data = $Value.data
    switch ($Value.kind) {
        'Binary' { $data = [byte[]]$Value.data }
        'MultiString' { $data = [string[]]$Value.data }
        'DWord' { $data = [int]$Value.data }
        'QWord' { $data = [long]$Value.data }
        default { $data = [string]$Value.data }
    }
    $Key.SetValue($Name, $data, $kind)
}

function Write-Tree($Base, [string]$KeyPath, $Tree) {
    if (-not $Tree.exists) { return }
    $key = $Base.CreateSubKey($KeyPath)
    try { foreach ($value in $Tree.values) { Write-Value $key $value.name $value } } finally { $key.Dispose() }
    foreach ($child in $Tree.children) { Write-Tree $Base ($KeyPath + '\' + $child.name) $child.tree }
}

$guid = if ($package.build.nsis.guid) { [string]$package.build.nsis.guid } else { Get-AppGuid $package.build.appId }
$ownedTrees = @(
    "Software\$guid",
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid",
    'Software\Classes\coredotdocs.hwpx', 'Software\Classes\coredotdocs.hwp', 'Software\Classes\coredotdocs.docx',
    'Software\coredotdocs\Capabilities', "Software\Classes\AppUserModelId\$($package.build.appId)"
)
$ownedValues = @(
    [ordered]@{ key = 'Software\RegisteredApplications'; name = 'coredotdocs' },
    [ordered]@{ key = 'Software\Classes\.hwpx\OpenWithProgids'; name = 'coredotdocs.hwpx' },
    [ordered]@{ key = 'Software\Classes\.hwp\OpenWithProgids'; name = 'coredotdocs.hwp' },
    [ordered]@{ key = 'Software\Classes\.docx\OpenWithProgids'; name = 'coredotdocs.docx' }
)

function Registry-Snapshot {
    $result = [ordered]@{}
    foreach ($hive in @('HKCU', 'HKLM')) {
        foreach ($view in @('64', '32')) {
            $base = Open-Registry $hive $view
            try {
                $trees = [ordered]@{}
                foreach ($key in $ownedTrees) { $trees[$key] = Read-Tree $base $key }
                $values = @($ownedValues | ForEach-Object { [ordered]@{ key = $_.key; name = $_.name; value = Read-Value $base $_.key $_.name; parentExisted = (Read-Tree $base $_.key).exists } })
                $defaults = [ordered]@{}
                foreach ($extension in @('hwpx', 'hwp', 'docx')) {
                    $defaults[".$extension"] = Read-Value $base "Software\Classes\.$extension" ''
                    if ($hive -eq 'HKCU') { $defaults[".$extension-UserChoice"] = Read-Tree $base "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$extension\UserChoice" }
                }
                $result["$hive-$view"] = [ordered]@{ trees = $trees; values = $values; defaults = $defaults }
            } finally { $base.Dispose() }
        }
    }
    return $result
}

function Restore-TestRegistry($Before, $Installed, $RestoreLog) {
    # Only whitelisted HKCU app keys/values may be restored. UserChoice is never written.
    foreach ($view in @('64', '32')) {
        $base = Open-Registry 'HKCU' $view
        try {
            $beforeView = $Before["HKCU-$view"]
            $installedView = $Installed["HKCU-$view"]
            foreach ($key in $ownedTrees) {
                $old = $beforeView.trees[$key]
                $test = $installedView.trees[$key]
                $now = Read-Tree $base $key
                if (Same-Json $old $now) { continue }
                Assert-True ((-not $now.exists) -or (Same-Json $now $test)) "Concurrent registry change; refusing to restore HKCU-$view\$key"
                if ($now.exists) { $base.DeleteSubKeyTree($key, $false) }
                Write-Tree $base $key $old
                $RestoreLog.Add("HKCU-$view\$key")
            }
            for ($index = 0; $index -lt $ownedValues.Count; $index++) {
                $definition = $ownedValues[$index]
                $old = $beforeView.values[$index].value
                $test = $installedView.values[$index].value
                $now = Read-Value $base $definition.key $definition.name
                if (Same-Json $old $now) { continue }
                Assert-True ((-not $now.exists) -or (Same-Json $now $test)) "Concurrent registry value change: $($definition.key)\$($definition.name)"
                $key = $base.CreateSubKey($definition.key)
                try {
                    if ($old.exists) { Write-Value $key $definition.name $old } else { $key.DeleteValue($definition.name, $false) }
                } finally { $key.Dispose() }
                $RestoreLog.Add("HKCU-$view\$($definition.key)\$($definition.name)")
            }
            foreach ($definition in $beforeView.values) {
                if ($definition.parentExisted) { continue }
                $now = Read-Tree $base $definition.key
                if ($now.exists -and $now.values.Count -eq 0 -and $now.children.Count -eq 0) { $base.DeleteSubKey($definition.key, $false) }
            }
        } finally { $base.Dispose() }
    }
}

function File-Snapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ exists = $false } }
    return [ordered]@{ exists = $true; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; bytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) }
}

function UserData-Fingerprints([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    return @(Get-ChildItem -LiteralPath $Directory -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{ relative = $_.FullName.Substring($Directory.Length); length = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
}

function Run-Hidden([string]$Executable, [string]$Arguments, [int]$TimeoutSeconds = 180) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $script:pendingInstaller = $process
        throw "Process exceeded $TimeoutSeconds seconds; inspect PID $($process.Id) before continuing: $Executable"
    }
    $process.Refresh()
    Assert-True ($process.ExitCode -eq 0) "$Executable exited with code $($process.ExitCode)"
}

$running = @(Get-CimInstance Win32_Process -Filter "Name='coredotdocs.exe'")
$plan = [ordered]@{ installer = $InstallerPath; expectedVersion = $package.version; appGuid = $guid; runningAppPids = @($running.ProcessId); scope = 'currentuser'; execute = [bool]$Execute }
if (-not $Execute) { $plan | ConvertTo-Json -Depth 4; return }
Assert-True ($running.Count -eq 0) 'An existing coredotdocs window is running. Coordinate its normal close before running this test; this harness never stops it.'
Assert-True (Test-Path -LiteralPath $InstallerPath -PathType Leaf) "Installer not found: $InstallerPath"
$installerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($InstallerPath).ProductVersion
Assert-True (Same-Version $installerVersion $package.version) "Expected installer $($package.version), found $installerVersion"
Get-Command $NodePath -ErrorAction Stop | Out-Null
$before = Registry-Snapshot
foreach ($entry in $before.GetEnumerator()) {
    Assert-True (-not $entry.Value.trees["Software\$guid"].exists) "An existing coredotdocs installation is registered in $($entry.Key); this test must not replace it."
    Assert-True (-not $entry.Value.trees["Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"].exists) "An existing uninstall entry is registered in $($entry.Key)."
}
$testRoot = Join-Path $desktopRoot ('dist/install-test-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$installDirectory = Join-Path $testRoot 'installed'
Assert-Contained (Join-Path $desktopRoot 'dist') $testRoot
Assert-Contained $testRoot $installDirectory
New-Item -ItemType Directory -Path $testRoot | Out-Null
$report = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); plan = $plan; testRoot = $testRoot; installDirectory = $installDirectory; checks = [Collections.Generic.List[string]]::new(); restoredRegistry = [Collections.Generic.List[string]]::new(); cleanupErrors = [Collections.Generic.List[string]]::new(); ok = $false }
Write-Json (Join-Path $testRoot 'registry-before.json') $before
$shortcuts = @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'coredotdocs.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'coredotdocs.lnk'))
$shortcutBefore = @($shortcuts | ForEach-Object { File-Snapshot $_ })
$shortcutInstalled = $null
$appData = Join-Path $env:APPDATA 'coredotdocs'
$userDataBefore = UserData-Fingerprints $appData
Write-Json (Join-Path $testRoot 'user-data-before.json') $userDataBefore
$cacheDirectory = Join-Path $env:LOCALAPPDATA ($package.name.ToLowerInvariant() + '-updater')
$cachePath = Join-Path $cacheDirectory 'installer.exe'
$cacheDirectoryExisted = Test-Path -LiteralPath $cacheDirectory
$cacheExisted = Test-Path -LiteralPath $cachePath -PathType Leaf
$cacheBeforeHash = if ($cacheExisted) { (Get-FileHash -LiteralPath $cachePath -Algorithm SHA256).Hash } else { $null }
$cacheBackup = Join-Path $testRoot 'updater-installer-before.exe'
if ($cacheExisted) { Copy-Item -LiteralPath $cachePath -Destination $cacheBackup }
$installerHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash
$report.installerSha256 = $installerHash
$report.installerBytes = (Get-Item -LiteralPath $InstallerPath).Length
$installed = $null
$attemptedInstall = $false
$script:pendingInstaller = $null
$failure = $null
try {
    $attemptedInstall = $true
    # NSIS requires /D to be the final argument and its path must not be quoted.
    Run-Hidden $InstallerPath "/S /currentuser /D=$installDirectory" 240
    $installed = Registry-Snapshot
    Write-Json (Join-Path $testRoot 'registry-installed.json') $installed
    $shortcutInstalled = @($shortcuts | ForEach-Object { File-Snapshot $_ })
    $executable = Join-Path $installDirectory 'coredotdocs.exe'
    Assert-Contained $testRoot $executable
    Assert-True (Test-Path -LiteralPath $executable -PathType Leaf) 'Installed executable is missing'
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
    $report.installedProductVersion = $versionInfo.ProductVersion
    $report.installedFileVersion = $versionInfo.FileVersion
    Assert-True (Same-Version $versionInfo.ProductVersion $package.version) 'Installed executable version mismatch'
    $report.checks.Add('per-user install and executable version')
    $sourceSkill = Join-Path $desktopRoot '../skills/coredotdocs/SKILL.md'
    $installedSkill = Join-Path $installDirectory 'resources/skills/coredotdocs/SKILL.md'
    Assert-True (Test-Path -LiteralPath $installedSkill -PathType Leaf) 'Installed agent skill is missing'
    $report.installedSkillSha256 = (Get-FileHash -LiteralPath $installedSkill -Algorithm SHA256).Hash
    Assert-True ($report.installedSkillSha256 -eq (Get-FileHash -LiteralPath $sourceSkill -Algorithm SHA256).Hash) 'Installed agent skill differs from release source'
    $skillLines = @(Get-Content -LiteralPath $installedSkill -Encoding UTF8 | ForEach-Object { $_.Trim() })
    $skillVersionLine = $skillLines | Where-Object { $_.StartsWith('version: ') } | Select-Object -First 1
    Assert-True ([bool]$skillVersionLine) 'Installed agent skill version is missing'
    $report.installedSkillVersion = $skillVersionLine.Substring('version: '.Length).Trim()
    Assert-True ($skillLines -contains ('server: coredotdocs ' + $package.version)) 'Installed skill server version differs from the release'
    $report.checks.Add('installed agent skill source hash and server version')
    foreach ($scope in $before.Keys) {
        Assert-True (Same-Json $before[$scope].defaults $installed[$scope].defaults) "Default associations or UserChoice changed: $scope"
        if ($scope.StartsWith('HKLM')) { Assert-True (Same-Json $before[$scope] $installed[$scope]) "Per-user installer changed machine registry: $scope" }
    }
    $current = Open-Registry 'HKCU' '64'
    try {
        Assert-True ((Read-Value $current "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" 'DisplayVersion').data -eq $package.version) 'Uninstall registry version mismatch'
        foreach ($extension in @('hwpx', 'hwp', 'docx')) {
            Assert-True (Read-Value $current "Software\Classes\.$extension\OpenWithProgids" "coredotdocs.$extension").exists "OpenWith registration missing for .$extension"
            Assert-True ((Read-Value $current "Software\Classes\coredotdocs.$extension\shell\open\command" '').data -eq ('"' + $executable + '" "%1"')) "Wrong launcher for .$extension"
        }
    } finally { $current.Dispose() }
    $report.checks.Add('OpenWith launchers and unchanged UserChoice/defaults')
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($shortcut in $shortcuts) {
            Assert-True (Test-Path -LiteralPath $shortcut -PathType Leaf) "Shortcut missing: $shortcut"
            $link = $shell.CreateShortcut($shortcut)
            Assert-True ($link.TargetPath -eq $executable) "Wrong shortcut target: $shortcut"
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
        }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    $report.checks.Add('desktop and Start Menu launcher targets')
    $previousNoForce = $env:CDD_TEST_NO_FORCE_KILL
    try {
        $env:CDD_TEST_NO_FORCE_KILL = '1'
        & $NodePath (Join-Path $PSScriptRoot 'smoke-app-win.cjs') $executable 2>&1 | Tee-Object -FilePath (Join-Path $testRoot 'installed-smoke.log')
    } finally { $env:CDD_TEST_NO_FORCE_KILL = $previousNoForce }
    Assert-True ($LASTEXITCODE -eq 0) 'Installed executable smoke failed'
    $report.checks.Add('installed app isolated-profile smoke')
} catch {
    $failure = $_
    $report.error = $_.Exception.Message
} finally {
    if ($attemptedInstall) {
        try {
            Assert-True ($null -eq $script:pendingInstaller) 'Installer still running; leave its registry and files intact for coordinated cleanup'
            Assert-True (@(Get-CimInstance Win32_Process -Filter "Name='coredotdocs.exe'").Count -eq 0) 'An app window is running; refusing to invoke the uninstaller or stop it'
            if ($null -eq $installed) { $installed = Registry-Snapshot }
            $uninstaller = Join-Path $installDirectory 'Uninstall coredotdocs.exe'
            if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
                Assert-Contained $testRoot $uninstaller
                Run-Hidden $uninstaller '/S /currentuser' 180
                $deadline = [DateTime]::UtcNow.AddSeconds(60)
                do {
                    $base = Open-Registry 'HKCU' '64'
                    try {
                        $registryPending = (Read-Tree $base "Software\$guid").exists -or (Read-Tree $base "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid").exists
                    } finally { $base.Dispose() }
                    $filesPending = Test-Path -LiteralPath (Join-Path $installDirectory 'coredotdocs.exe')
                    if (-not $registryPending -and -not $filesPending) { break }
                    Start-Sleep -Milliseconds 500
                } while ([DateTime]::UtcNow -lt $deadline)
            }
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $installDirectory 'coredotdocs.exe'))) 'Uninstall did not remove the app executable'
            $afterUninstall = Registry-Snapshot
            Write-Json (Join-Path $testRoot 'registry-uninstalled.json') $afterUninstall
            foreach ($scope in $before.Keys) {
                Assert-True (Same-Json $before[$scope].defaults $afterUninstall[$scope].defaults) "Uninstall changed default associations or UserChoice: $scope"
                if ($scope.StartsWith('HKLM')) { Assert-True (Same-Json $before[$scope] $afterUninstall[$scope]) "Uninstall changed machine registry: $scope" }
            }
            foreach ($key in $ownedTrees) { Assert-True (-not $afterUninstall['HKCU-64'].trees[$key].exists) "Uninstaller left app registry key: $key" }
            foreach ($value in $afterUninstall['HKCU-64'].values) { Assert-True (-not $value.value.exists) "Uninstaller left association value: $($value.key)\$($value.name)" }
            foreach ($shortcut in $shortcuts) { Assert-True (-not (Test-Path -LiteralPath $shortcut)) "Uninstaller left shortcut: $shortcut" }
            Assert-True (Same-Json $userDataBefore (UserData-Fingerprints $appData)) 'Existing user app data changed during install/uninstall'
            $report.checks.Add('uninstall removes app/launchers/associations and preserves user data')
        } catch { $report.cleanupErrors.Add($_.Exception.Message) }
        $safeToRestore = ($null -eq $script:pendingInstaller -and -not (Test-Path -LiteralPath (Join-Path $installDirectory 'coredotdocs.exe')))
        try { if ($safeToRestore -and $null -ne $installed) { Restore-TestRegistry $before $installed $report.restoredRegistry } } catch { $report.cleanupErrors.Add($_.Exception.Message) }
        for ($index = 0; $index -lt $shortcuts.Count; $index++) {
            try {
                if (-not $safeToRestore) { continue }
                $old = $shortcutBefore[$index]
                $now = File-Snapshot $shortcuts[$index]
                if (Same-Json $old $now) { continue }
                Assert-True ((-not $now.exists) -or ($null -ne $shortcutInstalled -and (Same-Json $now $shortcutInstalled[$index]))) "Concurrent shortcut change: $($shortcuts[$index])"
                if ($old.exists) { [IO.File]::WriteAllBytes($shortcuts[$index], [Convert]::FromBase64String($old.bytes)) }
                elseif ($now.exists) { Remove-Item -LiteralPath $shortcuts[$index] -Force }
            } catch { $report.cleanupErrors.Add($_.Exception.Message) }
        }
        try {
            if ($safeToRestore) {
                Assert-Contained $env:LOCALAPPDATA $cachePath
                $currentCacheHash = if (Test-Path -LiteralPath $cachePath -PathType Leaf) { (Get-FileHash -LiteralPath $cachePath -Algorithm SHA256).Hash } else { $null }
                if ($currentCacheHash -ne $cacheBeforeHash) {
                    Assert-True ($null -eq $currentCacheHash -or $currentCacheHash -eq $installerHash) 'Updater installer cache changed concurrently; refusing to overwrite it'
                    if ($cacheExisted) { Copy-Item -LiteralPath $cacheBackup -Destination $cachePath -Force }
                    elseif ($currentCacheHash) { Remove-Item -LiteralPath $cachePath -Force }
                }
                if (-not $cacheDirectoryExisted -and (Test-Path -LiteralPath $cacheDirectory) -and @(Get-ChildItem -LiteralPath $cacheDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $cacheDirectory }
            }
        } catch { $report.cleanupErrors.Add($_.Exception.Message) }
    }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    $report.ok = ($null -eq $failure -and $report.cleanupErrors.Count -eq 0)
    Write-Json (Join-Path $testRoot 'report.json') $report
    Write-Host "Install test report: $(Join-Path $testRoot 'report.json')"
}
if ($failure) { throw $failure }
Assert-True ($report.cleanupErrors.Count -eq 0) ($report.cleanupErrors -join '; ')
Write-Host 'Windows install/uninstall smoke OK'
