# scripts/install.ps1 - one-line installer for wenchat on Windows
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/dkisser/wenchat/main/scripts/install.ps1 | iex
#
# Env overrides (parameter form):
#   .\install.ps1 -Version v0.1.0 -InstallDir "$env:USERPROFILE\bin"
[CmdletBinding()]
param(
	[string]$Version,
	[string]$InstallDir = "$env:USERPROFILE\bin"
)

$ErrorActionPreference = "Stop"

$Repo = "dkisser/wenchat"
$BinName = "wenchat.exe"
$Target = "windows-x64"

# --- 1. Platform sanity check ------------------------------------------------
# Only x64 Windows is in the build matrix.
$Arch = [System.Environment]::Is64BitOperatingSystem
if (-not $Arch) {
	Write-Error "Error: 32-bit Windows is not supported. Use Windows x64 / ARM64 (x64 emulation)."
	exit 1
}
Write-Host "Detected platform: windows-x64"

# --- 2. Resolve version ------------------------------------------------------
if (-not $Version) {
	try {
		$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
		$Version = $Release.tag_name
	} catch {
		Write-Error "Error: failed to fetch latest release from GitHub API. Set -Version v0.1.0 to pin a specific version."
		exit 1
	}
}
if (-not $Version) {
	Write-Error "Error: could not determine version."
	exit 1
}

# --- 3. Download binary ------------------------------------------------------
$Url = "https://github.com/$Repo/releases/download/$Version/wenchat-$Version-$Target"
$Tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName())
try {
	Write-Host "Downloading wenchat $Version for $Target ..."
	Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing
} catch {
	Remove-Item -Path $Tmp -ErrorAction SilentlyContinue
	Write-Error "Error: download failed from $Url. Check that release $Version exists at https://github.com/$Repo/releases"
	exit 1
}

# --- 4. Install to PATH ------------------------------------------------------
try {
	if (-not (Test-Path -Path $InstallDir)) {
		New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
	}
	$InstallPath = Join-Path -Path $InstallDir -ChildPath $BinName
	if (Test-Path -Path $InstallPath) {
		Remove-Item -Path $InstallPath -Force
	}
	Move-Item -Path $Tmp -Destination $InstallPath -Force
} catch {
	Remove-Item -Path $Tmp -ErrorAction SilentlyContinue
	Write-Error "Error: failed to install to $InstallPath. Set -InstallDir to a writable path."
	exit 1
}

# --- 5. PATH advisory / mutation --------------------------------------------
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
	Write-Host ""
	Write-Host "Note: $InstallDir is not in your user PATH. Adding it now."
	[Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
	$env:Path = "$env:Path;$InstallDir"
	Write-Host "Restart PowerShell for the PATH change to take effect."
	Write-Host ""
}

# --- 6. Windows-specific first-run advisory ----------------------------------
Write-Host "Note (Windows): on first run, SmartScreen may show 'Unknown publisher'."
Write-Host "  Click 'More info' -> 'Run anyway' to whitelist."
Write-Host "  This is a one-time prompt for unsigned binaries."
Write-Host ""
Write-Host "Installed wenchat $Version -> $InstallPath"
Write-Host "Try it: wenchat alice   (or: & `"$InstallPath`" alice)"
