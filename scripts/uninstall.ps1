#requires -Version 7.0
<#
  卸载 dsh-butler：从 bundles 移除、删除 node_modules 目录。
  不会动 profile 的其它配置；最近一次备份在 butler-backup-* 里。
#>
[CmdletBinding()]
param([string]$Profile = "desktop")

$ErrorActionPreference = 'Stop'
$prof = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$dest = Join-Path $prof 'node_modules\dsh-butler'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force; Write-Host "[uninstall] 已删除 $dest" }

$pjPath = Join-Path $prof 'package.json'
$pj = Get-Content $pjPath -Raw -Encoding utf8 | ConvertFrom-Json
$bundles = @($pj.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-butler' })
$pj.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
$pj | ConvertTo-Json -Depth 12 | Set-Content $pjPath -Encoding utf8
Write-Host "[uninstall] 已从 bundles 移除 dsh-butler。重启 DSH 生效。"
