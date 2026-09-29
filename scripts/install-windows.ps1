param([Parameter(Mandatory=$true)][string]$ReleaseDirectory, [switch]$StartOnLogin)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $ReleaseDirectory).Path
if(!(Test-Path -LiteralPath (Join-Path $source 'release.json'))){throw 'Not a packaged Workspace release.'}
$version=(Get-Content -LiteralPath (Join-Path $source 'release.json') | ConvertFrom-Json)
if($version.platform -ne 'win32'){throw 'This package is not for Windows.'}
$nativeArchitecture=if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}
$expectedArch=switch($nativeArchitecture.ToUpperInvariant()){'AMD64' {'x64'} 'ARM64' {'arm64'} default {throw 'Unsupported Windows CPU architecture.'}}
if($version.arch -ne $expectedArch){throw "This package requires $($version.arch); this computer is $expectedArch."}
foreach($required in @('dist','node_modules','scripts','runtime\node.exe','package.json','README.md','docs\preview')){
  if(!(Test-Path -LiteralPath (Join-Path $source $required))){throw "Incomplete package: $required"}
}
$installRoot=Join-Path $env:LOCALAPPDATA 'Programs\AgentWorkspace'
$target=Join-Path $installRoot ('versions\'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'dist') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $source 'node_modules') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $source 'scripts') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $source 'runtime') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $target
Copy-Item -LiteralPath (Join-Path $source 'release.json') -Destination $target
Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination $target
Copy-Item -LiteralPath (Join-Path $source 'docs') -Destination $target -Recurse
$nodePath=Join-Path $target 'runtime\node.exe'
$launcher=Join-Path $installRoot 'launcher.mjs'
Copy-Item -LiteralPath (Join-Path $target 'scripts\installed-launcher.mjs') -Destination $launcher
$launchScript=Join-Path $installRoot 'Open Workspace.ps1'
$escapedNode=$nodePath.Replace("'","''")
$escapedLauncher=$launcher.Replace("'","''")
Set-Content -LiteralPath $launchScript -Encoding UTF8 -Value "Start-Process -FilePath '$escapedNode' -ArgumentList @('`"$escapedLauncher`"') -WindowStyle Hidden"
$backgroundScript=Join-Path $installRoot 'Background Workspace.ps1'
Set-Content -LiteralPath $backgroundScript -Encoding UTF8 -Value "Start-Process -FilePath '$escapedNode' -ArgumentList @('`"$escapedLauncher`"','--background') -WindowStyle Hidden"
$shell=New-Object -ComObject WScript.Shell
$locations=@([Environment]::GetFolderPath('Desktop'),(Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach($location in $locations){
  $shortcut=$shell.CreateShortcut((Join-Path $location 'Agent Workspace.lnk'))
  $shortcut.TargetPath=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  $shortcut.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launchScript+'"'
  $shortcut.WorkingDirectory=$target
  $shortcut.WindowStyle=7
  $shortcut.Description='Open your local human and agent workspace'
  $shortcut.Save()
}
if($StartOnLogin){
  $startupLocation=[Environment]::GetFolderPath('Startup')
  $startupShortcut=$shell.CreateShortcut((Join-Path $startupLocation 'Agent Workspace.lnk'))
  $startupShortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $startupShortcut.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$backgroundScript+'"'
  $startupShortcut.WorkingDirectory=$target
  $startupShortcut.WindowStyle=7
  $startupShortcut.Description='Start Agent Workspace when you sign in'
  $startupShortcut.Save()
}
Set-Content -LiteralPath (Join-Path $installRoot 'current.txt') -Value $target
Write-Output "Installed: $target"
