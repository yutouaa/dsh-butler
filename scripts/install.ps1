#requires -Version 7.0
<#
  从源码目录安装 dsh-butler 到 desktop profile（开发用；普通用户走插件市场或 npm）。
  - 备份 profile 的 package.json 与 cordis.patch.yml
  - 复制插件目录到 ~/.dsh/profiles/desktop/node_modules/dsh-butler
  - 把 dsh-butler 追加到 package.json 的 dsh.profile.bundles
  装完需要重启 DSH 才会加载。
#>
[CmdletBinding()]
param([string]$Profile = "desktop", [switch]$NoBundle)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$prof = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path $prof)) { throw "找不到 profile: $prof" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $prof "butler-backup-$stamp"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
Copy-Item (Join-Path $prof 'package.json') (Join-Path $bak 'package.json') -Force
if (Test-Path (Join-Path $prof 'cordis.patch.yml')) { Copy-Item (Join-Path $prof 'cordis.patch.yml') (Join-Path $bak 'cordis.patch.yml') -Force }
Write-Host "[install] 已备份 profile 配置 -> $bak"

$dest = Join-Path $prof 'node_modules\dsh-butler'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($item in 'package.json','cordis.patch.yml','README.md','README.en.md','CHANGELOG.md','LICENSE','lib','skills','locale') {
  $from = Join-Path $src $item
  if (Test-Path $from) { Copy-Item $from (Join-Path $dest $item) -Recurse -Force }
}
Write-Host "[install] 插件已复制 -> $dest"

if (-not $NoBundle) {
  $pjPath = Join-Path $prof 'package.json'
  $raw = Get-Content $pjPath -Raw -Encoding utf8
  $pj = $raw | ConvertFrom-Json
  if (-not $pj.dsh) { $pj | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $pj.dsh.profile) { $pj.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  $bundles = @($pj.dsh.profile.bundles | Where-Object { $_ })
  if ($bundles -notcontains 'dsh-butler') {
    $bundles += 'dsh-butler'
    $pj.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    $pj | ConvertTo-Json -Depth 12 | Set-Content $pjPath -Encoding utf8
    Write-Host "[install] 已把 dsh-butler 追加到 dsh.profile.bundles"
  } else {
    Write-Host "[install] bundles 里已存在 dsh-butler"
  }
}

Write-Host ""
Write-Host "完成。请重启 DeepSeek Harness 使插件生效。"
Write-Host "回滚：pwsh -File $(Join-Path $src 'scripts\uninstall.ps1')"
