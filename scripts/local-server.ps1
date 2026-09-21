[CmdletBinding()]
param(
  [ValidateSet('Start', 'Stop')]
  [string]$Action = 'Start',
  [switch]$NoBrowser,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$Runtime = Join-Path $ProjectRoot 'runtime'
$StateFile = Join-Path $Runtime 'local-server.json'
$EntryPoint = Join-Path $ProjectRoot 'server.js'
$StdoutLog = Join-Path $Runtime 'local-server.log'
$StderrLog = Join-Path $Runtime 'local-server.error.log'
$hash = [System.Security.Cryptography.SHA256]::Create()
try {
  $projectKey = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 24)
} finally { $hash.Dispose() }
$Marker = "--gpt-auth-bridge-local=$projectKey"
$mutex = New-Object System.Threading.Mutex($false, "Local\GPTAuthBridgeLocal-$projectKey")
$locked = $false
$startedProcess = $null
$exitCode = 0

function Test-ManagedProcess($Candidate) {
  if (-not $Candidate -or $Candidate.Name -ne 'node.exe') { return $false }
  $commandLine = [string]$Candidate.CommandLine
  return $commandLine.Contains($Marker) -and $commandLine.Contains('"' + $EntryPoint + '"')
}

function Get-Instance($Candidate) {
  if ($Candidate.CommandLine -notmatch '--local-url=(http://[^\s"]+)') {
    throw '启动记录不完整，无法识别服务地址。'
  }
  return [pscustomobject]@{
    processId = [int]$Candidate.ProcessId
    createdAt = $Candidate.CreationDate.ToUniversalTime().ToString('o')
    projectRoot = $ProjectRoot
    url = $Matches[1]
  }
}

function Save-Instance($Instance) {
  New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
  $Instance | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Find-Instance {
  if (Test-Path -LiteralPath $StateFile) {
    $saved = $null
    try { $saved = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    if ($saved -and $saved.projectRoot -eq $ProjectRoot -and [string]$saved.processId -match '^\d+$') {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.processId)"
      if ((Test-ManagedProcess $candidate) -and $candidate.CreationDate.ToUniversalTime().ToString('o') -eq $saved.createdAt) {
        return Get-Instance $candidate
      }
    }
  }
  # Recover our own process after a launcher interruption or a missing PID file.
  $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { Test-ManagedProcess $_ })
  if ($candidates.Count -gt 1) { throw '发现多个本项目的后台实例，请先检查进程，未执行启动或关闭。' }
  if ($candidates.Count -eq 1) {
    $instance = Get-Instance $candidates[0]
    Save-Instance $instance
    return $instance
  }
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  return $null
}

function Stop-Instance($Instance) {
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($Instance.processId)"
  if ($candidate) {
    if (-not (Test-ManagedProcess $candidate) -or $candidate.CreationDate.ToUniversalTime().ToString('o') -ne $Instance.createdAt) {
      throw '进程身份已变化，未关闭该进程。'
    }
    # Stop this instance and its Python/Chromium workers, never all Node processes.
    $killOutput = & taskkill.exe /PID $Instance.processId /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $Instance.processId -ErrorAction SilentlyContinue)) {
      throw "关闭进程失败，启动记录已保留。$killOutput"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (Get-Process -Id $Instance.processId -ErrorAction SilentlyContinue) {
      if ([DateTime]::UtcNow -ge $deadline) { throw '等待进程关闭超时，启动记录已保留。' }
      Start-Sleep -Milliseconds 100
    }
  }
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
}

function Read-LaunchConfig([string]$Node) {
  # Reuse the application's dotenv precedence, quoted values, comments and HOST.
  $program = @'
import { loadApplicationEnv } from './src/config.js';
import { validateStartupConfig } from './login-service/src/config/startup-config.js';
import { createRequire } from 'node:module';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error('Node.js 22.19.0 or later is required.');
  process.exit(1);
}
try {
  const require = createRequire(new URL('./package.json', import.meta.url));
  for (const name of Object.keys(require('./package.json').dependencies || {})) require.resolve(name);
} catch {
  console.error('Node dependencies are missing. Run npm ci in the project directory.');
  process.exit(1);
}
loadApplicationEnv();
const { port } = validateStartupConfig();
let host = process.env.HOST;
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
console.log(JSON.stringify({ port, url: `http://${host}:${port}` }));
'@
  $output = $program | & $Node --input-type=module
  if ($LASTEXITCODE -ne 0) { throw '环境或配置检查失败，请按上方提示修复后重试。' }
  return ($output | ConvertFrom-Json)
}

function Wait-Ready($Instance) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $port = ([Uri]$Instance.url).Port
  while ([DateTime]::UtcNow -lt $deadline) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($Instance.processId)"
    if (-not (Test-ManagedProcess $candidate)) {
      throw "服务进程已退出，请查看 $StderrLog"
    }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count) {
      if (-not ($listeners | Where-Object { $_.OwningProcess -eq $Instance.processId })) {
        throw "端口 $port 被其他程序占用，未关闭其他程序。请修改 .env 的 PORT。"
      }
      $request = [System.Net.HttpWebRequest]::Create("$($Instance.url)/api/ready")
      $request.Proxy = $null
      $request.Timeout = [Math]::Max(1, [Math]::Min(35000, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds))
      $request.ReadWriteTimeout = $request.Timeout
      $response = $null
      $reader = $null
      try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd() | ConvertFrom-Json
        if ([int]$response.StatusCode -eq 200 -and $body.ok -eq $true) { return }
        throw '服务就绪检查未通过，请运行 npm run check:runtime 检查 Python 和 Chromium 依赖。'
      } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
          $_.Exception.Response.Dispose()
          throw '服务就绪检查失败，请运行 npm run check:runtime 并查看 runtime 中的启动日志。'
        }
      } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
      }
    }
    Start-Sleep -Milliseconds 300
  }
  throw "服务在 45 秒内没有就绪，请查看 $StderrLog"
}

function Open-Service([string]$Url) {
  if (-not $NoBrowser) {
    try { Start-Process -FilePath $Url } catch { Write-Host "浏览器未能自动打开，请访问 $Url" }
  }
}

try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw '另一个启动或关闭操作正在执行，请稍后重试。' }
  Set-Location -LiteralPath $ProjectRoot
  $instance = Find-Instance
  if ($Action -eq 'Stop') {
    if ($instance) {
      Stop-Instance $instance
      Write-Host '本地服务及其子进程已关闭。'
    } else { Write-Host '本地服务未在运行。' }
  } elseif ($instance) {
    Wait-Ready $instance
    Write-Host "本地服务已经在运行：$($instance.url)"
    Open-Service $instance.url
  } else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '未找到 Node.js，请先安装 Node.js 22.19.0 或更高版本并重新打开终端。' }
    $config = Read-LaunchConfig $nodeCommand.Source
    if ([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $config.port }) {
      throw "端口 $($config.port) 被其他程序占用，未关闭其他程序。请修改 .env 的 PORT。"
    }
    New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
    Write-Host '正在启动并检查运行环境，请稍候...'
    $startedProcess = Start-Process -FilePath $nodeCommand.Source `
      -ArgumentList @(('"' + $EntryPoint + '"'), $Marker, "--local-url=$($config.url)") `
      -WorkingDirectory $ProjectRoot -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog `
      -WindowStyle Hidden -PassThru
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($startedProcess.Id)"
    if (-not (Test-ManagedProcess $candidate)) { throw "服务进程启动失败，请查看 $StderrLog" }
    $instance = Get-Instance $candidate
    Save-Instance $instance
    Wait-Ready $instance
    Write-Host "本地服务已启动：$($instance.url)"
    Write-Host '关闭启动窗口不影响服务；双击 stop.bat 可关闭服务。'
    Open-Service $instance.url
  }
} catch {
  $exitCode = 1
  Write-Host "操作失败：$($_.Exception.Message)" -ForegroundColor Red
  if ($startedProcess) {
    try {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($startedProcess.Id)"
      if (Test-ManagedProcess $candidate) { Stop-Instance (Get-Instance $candidate) }
      else { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
    } catch { Write-Host "清理启动进程失败：$($_.Exception.Message)" -ForegroundColor Red }
  }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
if ($exitCode -ne 0 -and -not $NoPause) { Read-Host '按 Enter 关闭窗口' | Out-Null }
exit $exitCode
