<#
.SYNOPSIS
Builds SADX Multiplayer with the SADX Online browser bridge and packages it in dist\.

.DESCRIPTION
1. Fetches the original mod (git submodule mod\sadx-multiplayer, pinned commit) and its submodules.
2. Applies mod\sadx-multiplayer.patch (hooks for our bridge + two address fixes) unless it is already applied.
3. Downloads the DirectX 8 headers the original mod needs into mod\.build\dx8, checked by SHA-256.
4. Builds libmodutils, ModLoaderCommon and the mod (Release|Win32) with MSBuild.
5. Writes the mod folder to dist\mods\sadx-multiplayer and zips it as dist\sadx-online-mod.zip.

Needs git and Visual Studio 2022 or its Build Tools with "Desktop development with C++" (MSVC v143 and a
Windows 10/11 SDK):
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
#>
param(
    # MSVC toolset used for the mod and for the two loader libraries (they ask for v141_xp, which nobody has).
    [string]$PlatformToolset = 'v143'
)

$ErrorActionPreference = 'Stop'
$ModDir = $PSScriptRoot
$RepoRoot = Split-Path $ModDir -Parent
$Upstream = Join-Path $ModDir 'sadx-multiplayer'
$Patch = Join-Path $ModDir 'sadx-multiplayer.patch'
$BuildDir = Join-Path $ModDir '.build'
$Dx8Dir = Join-Path $BuildDir 'dx8'
$Dist = Join-Path $RepoRoot 'dist'
$Package = Join-Path $Dist 'mods\sadx-multiplayer'
$Zip = Join-Path $Dist 'sadx-online-mod.zip'

# Microsoft's DirectX 8 headers (the DX8 SDK is no longer distributed), from BizHawk 1.11.6.
$Dx8Source = 'https://raw.githubusercontent.com/TASEmulators/BizHawk/1.11.6/libmupen64plus/D3D8Interceptor/D3D8Base/'
$Dx8Headers = [ordered]@{
    'd3d8.h'      = '5B1C945B8EA6FCD9589AD638AAA5346B28B02FC3AD010265A31BB1B17B8F55C9'
    'd3d8caps.h'  = '57564475FCC6A44AF0548A61132D04455A2002453AA1E9EE9666C4E3E2AC4ED2'
    'd3d8types.h' = '86408A3D88294857CFBDDF5C58B57D9E06354878825F2D3F601443E9798677B1'
}

function Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host "ERROR: $Text" -ForegroundColor Red; exit 1 }

# Runs a program and stops on a non-zero exit code. Windows PowerShell turns a native program's stderr into
# errors when output is redirected, so 'Stop' is relaxed while it runs (git reports progress on stderr).
function Invoke-Native([string]$File, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$([IO.Path]::GetFileName($File)) $($Arguments -join ' ') exited with code $LASTEXITCODE" }
}

function Test-Native([string]$File, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $File @Arguments 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not installed (winget install --id Git.Git -e).' }

Step 'Original mod (submodule mod\sadx-multiplayer)'
# core.longpaths: the loader's nested submodule lives deep inside .git\modules and can pass 260 characters.
Invoke-Native git @('-c', 'core.longpaths=true', '-C', $RepoRoot, 'submodule', 'update', '--init', '--recursive', '--', 'mod/sadx-multiplayer')
if (-not (Test-Path (Join-Path $Upstream 'external\sadx-mod-loader\SADXModLoader\include\SADXModLoader.h'))) {
    Fail 'The submodules are incomplete. Run: git submodule update --init --recursive'
}

Step 'Patch (mod\sadx-multiplayer.patch)'
if (Test-Native git @('-C', $Upstream, 'apply', '--reverse', '--check', $Patch)) {
    Write-Host '    already applied'
} elseif (Test-Native git @('-C', $Upstream, 'apply', '--check', $Patch)) {
    Invoke-Native git @('-C', $Upstream, 'apply', $Patch)
    Write-Host '    applied'
} else {
    Fail "mod\sadx-multiplayer has changes that conflict with the patch. To go back to the pinned original: git -C mod/sadx-multiplayer checkout -- ."
}

Step 'DirectX 8 headers (mod\.build\dx8)'
New-Item -ItemType Directory -Force -Path $Dx8Dir | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
foreach ($name in $Dx8Headers.Keys) {
    $file = Join-Path $Dx8Dir $name
    if ((Test-Path $file) -and (Get-FileHash $file -Algorithm SHA256).Hash -eq $Dx8Headers[$name]) { continue }
    Write-Host "    downloading $name"
    Invoke-WebRequest -UseBasicParsing -Uri ($Dx8Source + $name) -OutFile $file
    if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $Dx8Headers[$name]) {
        Remove-Item $file -Force
        Fail "$name does not match its expected SHA-256; not using it."
    }
}

Step 'MSBuild'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msbuild = $null
if (Test-Path $vswhere) {
    $msbuild = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
}
if (-not $msbuild) {
    Fail 'Visual Studio 2022 with C++ was not found. Install the Build Tools: winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
}
Write-Host "    $msbuild"

# Outputs and intermediates go to mod\.build (short paths: MSBuild's tracking logs fail past 260 characters,
# and the original's checkout stays clean). All three projects share OutDir, where the mod finds the two
# libraries. Directories end in '/' rather than '\': a trailing backslash would escape the closing quote that
# Windows PowerShell adds around arguments with spaces.
$OutDir = Join-Path $BuildDir 'bin'
$common = @('/nologo', '/m', '/v:minimal', '/p:Configuration=Release', '/p:Platform=Win32',
    "/p:SolutionDir=$Upstream/", "/p:OutDir=$OutDir/", "/p:PlatformToolset=$PlatformToolset",
    '/p:WindowsTargetPlatformVersion=10.0')
foreach ($project in @(
        'external\sadx-mod-loader\libmodutils\libmodutils.vcxproj',
        'external\sadx-mod-loader\mod-loader-common\ModLoaderCommon\ModLoaderCommon.vcxproj',
        'source\sadx-multiplayer.vcxproj')) {
    $name = [IO.Path]::GetFileNameWithoutExtension($project)
    Step "Building $name"
    Invoke-Native $msbuild (@((Join-Path $Upstream $project), "/p:IntDir=$(Join-Path $BuildDir "obj\$name")/") + $common)
}

$dll = Join-Path $OutDir 'sadx-multiplayer.dll'
if (-not (Test-Path $dll)) { Fail "The build finished but $dll is missing." }

Step 'Package (dist\mods\sadx-multiplayer)'
if (Test-Path $Package) { Remove-Item $Package -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Package | Out-Null
Copy-Item (Join-Path $Upstream 'resources\mod\*') $Package -Recurse
Copy-Item (Join-Path $ModDir 'mod.ini') $Package -Force
Copy-Item $dll $Package
if (Test-Path $Zip) { Remove-Item $Zip -Force }
# Windows' own tar.exe (Windows 10 1803+) writes '/' separators; Windows PowerShell's Compress-Archive writes '\'.
# By full path: the GNU tar that Git for Windows puts on PATH can't write zip files and reads 'D:\' as a host.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) {
    Invoke-Native $tar @('-a', '-c', '-f', $Zip, '-C', (Join-Path $Dist 'mods'), 'sadx-multiplayer')
} else {
    Compress-Archive -Path $Package -DestinationPath $Zip
}

$hash = (Get-FileHash (Join-Path $Package 'sadx-multiplayer.dll') -Algorithm SHA256).Hash
Write-Host ''
Write-Host "Mod:  $Package" -ForegroundColor Green
Write-Host "Zip:  $Zip"
Write-Host "DLL SHA-256: $hash"
Write-Host 'Install it into the game with: node gateway/agent-cli.mjs setup --sadx "<SADX folder>"'
