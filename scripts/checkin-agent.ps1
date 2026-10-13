<#
.SYNOPSIS
  Check-In agent for Windows (Windows PowerShell 5.1 or PowerShell 7+).            version 2.2.0

.DESCRIPTION
  1. Asks the server whether it is accepting check-ins   (GET  /api/status)
  2. Only if it is: gathers the selected details        (CPU sample takes 1s)
  3. Sends them, using the computer name as the ID       (POST /api/checkin)

  Settings come from parameters, then environment variables (CHECKIN_URL, CHECKIN_API_KEY, ...),
  then the config file written by -Install (C:\ProgramData\CheckIn\agent.json).
  Fields a machine can't provide are left out. Run elevated (or as SYSTEM) for every field.

  FIELD GROUPS  (default = everything except updates and security)
    system    hostname, fqdn, os, os_version, os_build, os_release, arch, vendor, model, serial, virtualization
    cpu       cpu_pct, cpu_cores, cpu_model
    ram       ram_pct, ram_used_mb, ram_total_mb, swap_pct
    disk      activity: disk_busy_pct (% of one second the busiest physical disk was busy)
              space: disk_pct (% of the system drive used), disk_free_gb, disk_size_gb,
              disk_max_pct and disk_max_mount (the fullest drive)
    time      system_time, timezone, time_synced, time_source
    uptime    boot_time, uptime, uptime_h
    network   ip, interface, mac, gateway, dns_servers
    domain    domain_joined, domain, domain_type, domain_role, entra_joined, entra_tenant, secure_channel_ok, workgroup
    users     users_logged_in, logged_in_users
    health    processes, failed_services, failed_service_names, reboot_required
    updates   pending_updates, security_updates, last_update, last_hotfix                         (slower)
    security  firewall_enabled, firewall_profiles, av_product, av_enabled, av_realtime,
              av_signature_age_days, secure_boot, disk_encrypted
    topprocs  top_cpu, top_ram, top_disk: the 3 busiest process NAMES, each only while that metric is
              over 85% (cpu_pct, ram_pct, disk_busy_pct; set $DefaultTopThreshold). Off unless asked for
              ("all" or -Fields default,topprocs); needs the cpu, ram and disk groups. Disk is the
              process's total I/O (disk, network and pipes) in MB/s, and needs an elevated run

  EXIT CODES   0 sent (or dry run)   2 server paused, nothing sent   1 error

.PARAMETER Url
  Server base URL, e.g. https://checkin.example.com
.PARAMETER ApiKey
  API key (needed once one is set on the server).
.PARAMETER Id
  Record ID. Default: the computer name.
.PARAMETER Fields
  Groups to send, comma-separated. "default" (the default), "all", or e.g. "cpu,ram,disk".
  "default" can be combined: "default,security".
.PARAMETER Exclude
  Groups to skip, e.g. "users,network".
.PARAMETER Extra
  Extra fields, e.g. "site=Dallas,owner=it-infra". A value can use environment variables, read on
  every run: %NAME%, ${NAME} or ${NAME:-fallback}, e.g. 'site=%SITE%,owner=${OWNER:-it}'.
  Use single quotes in PowerShell so the reference is stored, not today's value.
.PARAMETER CheckPorts
  With each check-in, ask the server to test these TCP ports on this computer (e.g. 3389) and save
  port_3389 = open / closed on its record. Needs port checks turned on (dashboard: Admin > Port checks).
.PARAMETER PortCheck
  Just ask the server whether these ports on this computer are reachable from it, print the answer
  and exit (exit code 0 = all open, 3 = some not open). Sends no check-in.
.PARAMETER Insecure
  Accept a self-signed certificate.
.PARAMETER DryRun
  Print the JSON instead of sending it (doesn't contact the server).
.PARAMETER Force
  Send even if the server reports that it is paused.
.PARAMETER List
  Show the field groups and exit.
.PARAMETER Install
  Copy the agent to C:\ProgramData\CheckIn, save the settings there (admins and SYSTEM only)
  and create a scheduled task that runs it as SYSTEM every -Every minutes. Needs an elevated prompt.
.PARAMETER Every
  Minutes between runs for -Install (1-1439). Default 5.
.PARAMETER ReplaceSettings
  With -Install: exclude, extra fields, port checks and -Insecure are exactly what this command
  says, and anything left out is cleared (the one-line installer uses this). Without it, settings
  not given keep their saved values. The saved API key, -Id and -Proxy are always kept unless given.
.PARAMETER Uninstall
  Remove the scheduled task, the copied agent and its settings.
.PARAMETER RemoveRecord
  With -Uninstall: also delete this computer's record on the server (uses the saved URL and API key).
.PARAMETER Proxy
  Web proxy, e.g. http://proxy.contoso.com:8080. Needed when the server is only reachable through a proxy,
  because the SYSTEM account used by the scheduled task has no proxy settings of its own.

.NOTES
  One-line install (downloads this script from your server and sets it up to report back there),
  in an elevated PowerShell:   irm https://YOUR-SERVER/install.ps1 | iex
  The dashboard's "Add Device" page builds this line with your options and API key.
.EXAMPLE
  .\checkin-agent.ps1 -DryRun -Fields all
.EXAMPLE
  .\checkin-agent.ps1 -Url https://checkin.example.com -ApiKey ck_xxx -Fields cpu,ram,disk,domain
.EXAMPLE
  .\checkin-agent.ps1 -Install -Url https://checkin.example.com -ApiKey ck_xxx -Every 5 -Extra "site=Dallas"
#>
[CmdletBinding()]
param(
  [string]$Url,
  [string]$ApiKey,
  [string]$Id,
  [string[]]$Fields,
  [string[]]$Exclude,
  [string]$Extra,
  [string[]]$CheckPorts,
  [string[]]$PortCheck,
  [switch]$Insecure,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$List,
  [switch]$Install,
  [ValidateRange(1, 1439)][int]$Every,
  [switch]$ReplaceSettings,
  [switch]$Uninstall,
  [switch]$RemoveRecord,
  [string]$Proxy,
  [string]$Config
)

# ---- SETTINGS - change these ----------------------------------------------------------------
# Used when a value isn't given as a parameter, in a CHECKIN_* environment variable or in the
# config file. Machines set up with the one-line installer (https://YOUR-SERVER/install.ps1)
# have their own values in C:\ProgramData\CheckIn\agent.json, which win over these - edit that
# file to change one machine; edit here (or src/agents.js INSTALL_DEFAULTS) to change future installs.
$DefaultUrl = ''                 # server, e.g. https://checkin.example.com
$DefaultFields = 'default'       # field groups to send: default, all, or e.g. cpu,ram,disk
$DefaultExclude = ''             # field groups to skip
$DefaultExtra = ''               # extra fields, e.g. 'site=Dallas,owner=%OWNER%' (see -Extra)
$DefaultEvery = 5                # minutes between runs when installing (1-1439)
$DefaultTopThreshold = 85       # topprocs group: list the top processes while CPU, RAM or disk busy % is above this
$DefaultCheckPorts = ''          # ports the server tests on each check-in, e.g. '3389' (needs Admin > Port checks)
# What "default" means (the groups sent when nothing else is chosen):
$DefaultGroups = @('system', 'cpu', 'ram', 'disk', 'time', 'uptime', 'network', 'domain', 'users', 'health')
# ----------------------------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $PSBoundParameters.ContainsKey('Every')) { $Every = $DefaultEvery }
$Version = '2.2.0'
$TaskName = 'Check-In Agent'
$HomeDir = Join-Path $env:ProgramData 'CheckIn'
$InstalledScript = Join-Path $HomeDir 'checkin-agent.ps1'
$DefaultConfig = Join-Path $HomeDir 'agent.json'
$AllGroups = @('system', 'cpu', 'ram', 'disk', 'time', 'uptime', 'network', 'domain', 'users', 'health', 'updates', 'security', 'topprocs')

function Write-Log([string]$Message) {
  Write-Host $Message
  # Keep the last result next to the installed agent, handy when it runs as a scheduled task.
  if (Test-Path $HomeDir) {
    try { "$(Get-Date -Format s)  $Message" | Out-File -FilePath (Join-Path $HomeDir 'last-run.txt') -Encoding utf8 -Force } catch { }
  }
}
function Stop-Agent([string]$Message) { Write-Log "check-in agent: $Message"; exit 1 }
# Any unexpected error still ends with a logged message and exit code 1.
trap { Write-Log "check-in agent: $($_.Exception.Message)"; exit 1 }
# Runs a Windows command without letting its error output stop the script
# (Windows PowerShell 5.1 turns redirected stderr into a terminating error under 'Stop').
function Invoke-Native([string]$Exe, [string[]]$ArgList = @(), [switch]$Merge) {
  $ErrorActionPreference = 'Continue'
  if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { $global:LASTEXITCODE = 9009; return @() }
  if ($Merge) { $out = & $Exe @ArgList 2>&1 } else { $out = & $Exe @ArgList 2>$null }
  return @($out | ForEach-Object { [string]$_ })
}
function Test-Admin {
  try {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

if ($List) {
  $help = Get-Content -LiteralPath $PSCommandPath
  $start = [array]::IndexOf($help, ($help | Where-Object { $_ -match '^\s+FIELD GROUPS' } | Select-Object -First 1))
  $end = [array]::IndexOf($help, ($help | Where-Object { $_ -match '^\s+EXIT CODES' } | Select-Object -First 1))
  $help[$start..($end - 2)] | ForEach-Object { $_.Substring([Math]::Min(2, $_.Length)) }
  exit 0
}

# ---- settings: parameters > environment > config file ------------------------------------
$cfgPath = if ($Config) { $Config } elseif ($env:CHECKIN_CONFIG) { $env:CHECKIN_CONFIG } else { $DefaultConfig }
$cfg = @{}
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $json = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    foreach ($p in $json.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
  } catch { Stop-Agent "could not read $cfgPath : $($_.Exception.Message)" }
}
function Get-Setting([string]$Param, [string]$EnvName, [string]$CfgName, $Fallback = '') {
  if ($Param) { return $Param }
  $e = [Environment]::GetEnvironmentVariable($EnvName)
  if ($e) { return $e }
  if ($cfg.ContainsKey($CfgName) -and $cfg[$CfgName]) { return [string]$cfg[$CfgName] }
  return $Fallback
}
$Url = (Get-Setting $Url 'CHECKIN_URL' 'Url' $DefaultUrl).TrimEnd('/')
$ApiKey = Get-Setting $ApiKey 'CHECKIN_API_KEY' 'ApiKey'
$Id = Get-Setting $Id 'CHECKIN_ID' 'Id'
# -Fields cpu,ram (a list) and -Fields "cpu,ram" (text) both work.
$Fields = Get-Setting ($Fields -join ',') 'CHECKIN_FIELDS' 'Fields' $DefaultFields
# With -ReplaceSettings, the options the installer manages ignore the saved file.
$managed = { param($name) if ($ReplaceSettings) { "__none_$name" } else { $name } }
$Exclude = Get-Setting ($Exclude -join ',') 'CHECKIN_EXCLUDE' (& $managed 'Exclude') $DefaultExclude
$Proxy = Get-Setting $Proxy 'CHECKIN_PROXY' 'Proxy'
$Extra = Get-Setting $Extra 'CHECKIN_EXTRA' (& $managed 'Extra') $DefaultExtra
$TopThreshold = 0
if (-not [int]::TryParse((Get-Setting '' 'CHECKIN_TOP_THRESHOLD' 'TopThreshold' $DefaultTopThreshold), [ref]$TopThreshold) -or $TopThreshold -lt 1 -or $TopThreshold -gt 100) { $TopThreshold = 85 }
# -CheckPorts 3389,443 (a list) and -CheckPorts "3389,443" (text) both work.
# (New names: the parameters are string arrays, and a plain string is what gets sent and saved.)
$PortsEachRun = [string]((Get-Setting ($CheckPorts -join ',') 'CHECKIN_CHECK_PORTS' (& $managed 'CheckPorts') $DefaultCheckPorts) -replace '\s', '')
if ($PortsEachRun -and $PortsEachRun -notmatch '^\d{1,5}(,\d{1,5})*$') { Stop-Agent '-CheckPorts must be port numbers separated by commas, e.g. 3389 or 3389,443' }
$PortsOnce = [string](($PortCheck -join ',') -replace '\s', '')
if ($PortsOnce -and $PortsOnce -notmatch '^\d{1,5}(,\d{1,5})*$') { Stop-Agent '-PortCheck must be port numbers separated by commas, e.g. 3389 or 3389,443' }
if (-not $Insecure) { $Insecure = [bool](($env:CHECKIN_INSECURE -eq '1') -or (-not $ReplaceSettings -and $cfg.ContainsKey('Insecure') -and $cfg['Insecure'])) }

# Resolve the group list.
$selected = New-Object System.Collections.Generic.List[string]
foreach ($g in ($Fields -split '[,;\s]+' | Where-Object { $_ })) {
  $g = $g.ToLowerInvariant()
  if ($g -eq 'all') { $AllGroups | ForEach-Object { if (-not $selected.Contains($_)) { $selected.Add($_) } } }
  elseif ($g -eq 'default') { $DefaultGroups | ForEach-Object { if (-not $selected.Contains($_)) { $selected.Add($_) } } }
  elseif ($AllGroups -contains $g) { if (-not $selected.Contains($g)) { $selected.Add($g) } }
  else { Stop-Agent "unknown field group: $g (use -List)" }
}
foreach ($g in ($Exclude -split '[,;\s]+' | Where-Object { $_ })) {
  $g = $g.ToLowerInvariant()
  if ($AllGroups -notcontains $g) { Stop-Agent "unknown field group in -Exclude: $g (use -List)" }
  [void]$selected.Remove($g)
}
function Want([string]$Group) { return $selected.Contains($Group) }

if ($PSVersionTable.PSVersion.Major -lt 6) {
  # Windows PowerShell 5.1 may default to TLS 1.0; servers need 1.2.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if ($Insecure) { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }
}

# ---- install / uninstall -----------------------------------------------------------------
if ($Uninstall) {
  if (-not (Test-Admin)) { Stop-Agent '-Uninstall needs an elevated (Run as administrator) prompt' }
  if ($RemoveRecord) {
    $rid = if ($Id) { $Id } else { $env:COMPUTERNAME }
    if (-not $Url) { Write-Host "No server URL known, so the record for $rid was not removed. Delete it in the dashboard." }
    else {
      $d = @{ Uri = "$Url/api/records/$([uri]::EscapeDataString($rid))"; Method = 'DELETE'; UseBasicParsing = $true; TimeoutSec = 20; Headers = @{} }
      if ($ApiKey) { $d.Headers['x-api-key'] = $ApiKey }
      if ($Proxy) { $d.Proxy = $Proxy }
      if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 6) { $d.SkipCertificateCheck = $true }
      try { Invoke-WebRequest @d | Out-Null; Write-Host "Removed the record for $rid from $Url." }
      catch {
        $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 404) { Write-Host "There was no record for $rid on $Url." }
        else { Write-Host "Could not remove the record for $rid ($($_.Exception.Message)). Delete it in the dashboard." }
      }
    }
  }
  Invoke-Native schtasks.exe @('/Delete', '/TN', $TaskName, '/F') | Out-Null
  if (Test-Path $HomeDir) { Remove-Item -LiteralPath $HomeDir -Recurse -Force }
  Write-Host 'Removed the Check-In agent.'
  exit 0
}

if ($Install) {
  if (-not (Test-Admin)) { Stop-Agent '-Install needs an elevated (Run as administrator) prompt' }
  if (-not $Url) { Stop-Agent '-Install needs -Url' }
  New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
  # Settings hold the API key: only SYSTEM and Administrators may read the folder.
  & icacls.exe $HomeDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {
    if ($PSCommandPath -ne $InstalledScript) { Copy-Item -LiteralPath $PSCommandPath -Destination $InstalledScript -Force }
  } else {
    $dl = @{ UseBasicParsing = $true; Uri = "$Url/agent/checkin-agent.ps1"; OutFile = $InstalledScript }
    if ($Proxy) { $dl.Proxy = $Proxy }
    if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 6) { $dl.SkipCertificateCheck = $true }
    Invoke-WebRequest @dl
  }
  $settings = [ordered]@{ Url = $Url; ApiKey = $ApiKey; Id = $Id; Fields = $Fields; Exclude = $Exclude; Extra = $Extra; CheckPorts = $PortsEachRun; Insecure = [bool]$Insecure; Proxy = $Proxy }
  $settings | ConvertTo-Json | Out-File -FilePath $DefaultConfig -Encoding utf8 -Force
  # The task is defined in XML so it also runs on battery, can't pile up, and is stopped if a run hangs.
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $esc = { param($t) [Security.SecurityElement]::Escape([string]$t) }
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Sends this computer's status to the Check-In server ($(& $esc $Url)).</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition><Interval>PT$($Every)M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>$((Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss'))</StartBoundary>
      <RandomDelay>PT30S</RandomDelay>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <BootTrigger><Delay>PT2M</Delay><Enabled>true</Enabled></BootTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $esc $ps)</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$(& $esc $InstalledScript)"</Arguments>
    </Exec>
  </Actions>
</Task>
"@
  $xmlPath = Join-Path $HomeDir 'task.xml'
  $xml | Out-File -FilePath $xmlPath -Encoding Unicode -Force
  $out = Invoke-Native schtasks.exe @('/Create', '/TN', $TaskName, '/XML', $xmlPath, '/F') -Merge
  $rc = $LASTEXITCODE
  Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
  if ($rc -ne 0) { Stop-Agent "could not create the scheduled task: $($out -join ' ')" }
  Write-Host "Installed: scheduled task '$TaskName' runs as SYSTEM every $Every minute(s)."
  Write-Host "Settings: $DefaultConfig    Last result: $(Join-Path $HomeDir 'last-run.txt')"
  Invoke-Native schtasks.exe @('/Run', '/TN', $TaskName) | Out-Null
  exit 0
}

# ---- helpers -----------------------------------------------------------------------------
if (-not $Url -and -not $DryRun) { Stop-Agent "no server URL: use -Url, CHECKIN_URL or $DefaultConfig" }
function Invoke-Api([string]$Method, [string]$Path, [string]$Body) {
  $p = @{ Uri = "$Url$Path"; Method = $Method; UseBasicParsing = $true; TimeoutSec = 20; Headers = @{} }
  if ($ApiKey) { $p.Headers['x-api-key'] = $ApiKey }
  if ($Proxy) { $p.Proxy = $Proxy }
  if ($Body) { $p.Body = [Text.Encoding]::UTF8.GetBytes($Body); $p.ContentType = 'application/json; charset=utf-8' }
  if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 6) { $p.SkipCertificateCheck = $true }
  try {
    $r = Invoke-WebRequest @p
    return @{ Status = [int]$r.StatusCode; Body = [string]$r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw }
    $text = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $text = $_.ErrorDetails.Message
      try { $j = $text | ConvertFrom-Json; if ($j.error) { $text = [string]$j.error } } catch { }
    }
    return @{ Status = [int]$resp.StatusCode; Body = $text }
  }
}
$data = [ordered]@{}
function Add-Field([string]$Name, $Value) {
  if ($null -eq $Value) { return }
  if ($Value -is [string]) { $Value = $Value.Trim(); if ($Value -eq '') { return } }
  $data[$Name] = $Value
}
function Try-Group([string]$Name, [scriptblock]$Block) {
  # One failing group never stops the check-in; it's reported in agent_errors instead.
  try { & $Block } catch { $script:groupErrors += "$Name : $($_.Exception.Message)" }
}
$groupErrors = @()
function Format-Duration([TimeSpan]$t) {
  if ($t.Days -gt 0) { return '{0}d {1}h {2}m' -f $t.Days, $t.Hours, $t.Minutes }
  if ($t.Hours -gt 0) { return '{0}h {1}m' -f $t.Hours, $t.Minutes }
  return '{0}m' -f $t.Minutes
}
function Format-Time([datetime]$d) { return $d.ToString('yyyy-MM-ddTHH:mm:sszzz') }
function Pct($used, $total) { if ($total -gt 0) { return [Math]::Round(100.0 * $used / $total, 1) } }
$isAdmin = Test-Admin

# "port 3389: open" lines from a server reply's ports object.
function Format-Ports($ports) {
  if ($null -eq $ports) { return @() }
  return @($ports.PSObject.Properties | ForEach-Object { "  port $($_.Name): $($_.Value)" })
}

# ---- -PortCheck: ask once, print, exit -----------------------------------------------------
if ($PortsOnce) {
  try { $pc = Invoke-Api 'GET' "/api/portcheck?ports=$PortsOnce" } catch { Stop-Agent "could not reach $Url/api/portcheck : $($_.Exception.Message)" }
  if ($pc.Status -ne 200) { Stop-Agent "port check failed (HTTP $($pc.Status)): $($pc.Body)" }
  $res = $pc.Body | ConvertFrom-Json
  Write-Log ((@("Ports on $($res.ip), as seen from ${Url}:") + (Format-Ports $res.ports)) -join [Environment]::NewLine)
  if (@($res.ports.PSObject.Properties | Where-Object { $_.Value -ne 'open' }).Count) { exit 3 }
  exit 0
}

# ---- 1. is the server accepting check-ins? -------------------------------------------------
if (-not $DryRun -and -not $Force) {
  try { $st = Invoke-Api 'GET' '/api/status' } catch { Stop-Agent "could not reach $Url/api/status : $($_.Exception.Message)" }
  if ($st.Status -eq 401 -or $st.Status -eq 403) { Stop-Agent "server refused the API key (HTTP $($st.Status)): $($st.Body)" }
  if ($st.Status -ne 200) { Stop-Agent "unexpected reply from $Url/api/status (HTTP $($st.Status)): $($st.Body)" }
  try { $status = $st.Body | ConvertFrom-Json } catch { Stop-Agent "unexpected reply from $Url/api/status: $($st.Body)" }
  if ($status.accepting -ne $true) { Write-Log 'Server is paused (not accepting check-ins). Nothing gathered or sent.'; exit 2 }
}

# ---- 2. gather -----------------------------------------------------------------------------
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$hostname = $env:COMPUTERNAME
if ($Id) { Add-Field 'id' $Id } else { Add-Field 'id' $hostname }
Add-Field 'hostname' $hostname

if (Want 'system') { Try-Group 'system' {
  try { $fq = [Net.Dns]::GetHostEntry('').HostName; if ($fq -and $fq -ne $hostname) { Add-Field 'fqdn' $fq.ToLowerInvariant() } } catch { }
  Add-Field 'os' ($os.Caption -replace '^Microsoft\s+', '')
  Add-Field 'os_version' $os.Version
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  if ($cv) {
    if ($cv.CurrentBuild) { Add-Field 'os_build' ("{0}.{1}" -f $cv.CurrentBuild, $cv.UBR) }
    if ($cv.DisplayVersion) { Add-Field 'os_release' $cv.DisplayVersion } elseif ($cv.ReleaseId) { Add-Field 'os_release' $cv.ReleaseId }
  }
  Add-Field 'arch' $os.OSArchitecture
  Add-Field 'vendor' $cs.Manufacturer
  Add-Field 'model' $cs.Model
  try { Add-Field 'serial' (Get-CimInstance Win32_BIOS).SerialNumber } catch { }
  $sig = "$($cs.Manufacturer) $($cs.Model)"
  $virt = switch -Regex ($sig) {
    'VMware' { 'vmware'; break }
    'VirtualBox|innotek' { 'oracle'; break }
    'Microsoft Corporation Virtual' { 'microsoft'; break }
    'QEMU|KVM|Bochs' { 'kvm'; break }
    'Xen|HVM domU' { 'xen'; break }
    'Amazon EC2' { 'amazon'; break }
    'Google' { 'google'; break }
    'Parallels' { 'parallels'; break }
    default { if ($cs.HypervisorPresent -and $cs.Model -match 'Virtual') { 'vm' } else { 'none' } }
  }
  Add-Field 'virtualization' $virt
} }

# ---- topprocs helpers: the busiest process names ------------------------------------------
# One row per process NAME (processes sharing a name are added up): CPU time (100 ns units), working set
# (bytes) and I/O bytes read + written, from a single Win32_Process query. Only names are used.
function Get-ProcSnapshot {
  $t0 = [DateTime]::UtcNow
  $rows = @{}
  $q = 'SELECT Name, ProcessId, KernelModeTime, UserModeTime, WorkingSetSize, ReadTransferCount, WriteTransferCount FROM Win32_Process'
  foreach ($p in @(Get-CimInstance -Query $q -ErrorAction Stop)) {
    if ([int]$p.ProcessId -eq 0) { continue }   # System Idle Process: its "CPU time" is idle time
    $n = ([IO.Path]::GetFileNameWithoutExtension([string]$p.Name) -replace '[,\r\n]', ' ').Trim()
    if (-not $n) { continue }
    if (-not $rows.ContainsKey($n)) { $rows[$n] = @{ cpu = [double]0; ws = [double]0; io = [double]0 } }
    $rows[$n].cpu += [double]$p.KernelModeTime + [double]$p.UserModeTime
    $rows[$n].ws += [double]$p.WorkingSetSize
    $rows[$n].io += [double]$p.ReadTransferCount + [double]$p.WriteTransferCount
  }
  $t1 = [DateTime]::UtcNow
  # The reading is spread over the query, so its time is the middle of it.
  return [pscustomobject]@{ Mid = $t0.AddTicks([long](($t1 - $t0).Ticks / 2)); Rows = $rows }
}
# "name 38%, other 21%": the top three of cpu | ram | disk. $Before is only needed for cpu and disk.
# (PowerShell variable names ignore case, so the snapshots are not called $A / $B next to $a / $b.)
function Format-TopProcs([string]$Mode, $Before, $After, [double]$Cores, [double]$TotalKb) {
  $secs = if ($Before) { ($After.Mid - $Before.Mid).TotalSeconds } else { 0 }
  if ($Mode -ne 'ram' -and $secs -le 0) { return '' }
  $vals = foreach ($name in $After.Rows.Keys) {
    $now = $After.Rows[$name]
    $was = if ($Before -and $Before.Rows.ContainsKey($name)) { $Before.Rows[$name] } else { @{ cpu = 0; io = 0 } }
    $v = switch ($Mode) {
      'cpu' { [Math]::Max(0, $now.cpu - $was.cpu) / 1e7 / $secs / [Math]::Max(1, $Cores) * 100 }
      'ram' { $now.ws }
      default { [Math]::Max(0, $now.io - $was.io) / $secs }
    }
    [pscustomobject]@{ Name = $name; V = [double]$v }
  }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $out = foreach ($t in ($vals | Sort-Object V -Descending | Select-Object -First 3)) {
    switch ($Mode) {
      'cpu' { if ($t.V -ge 0.5) { '{0} {1}%' -f $t.Name, [Math]::Round($t.V) } }
      'ram' {
        if ($t.V -ge 1MB) {
          $size = if ($t.V -ge 1GB) { ($t.V / 1GB).ToString('0.0', $inv) + ' GB' } else { [Math]::Round($t.V / 1MB).ToString($inv) + ' MB' }
          if ($TotalKb -gt 0) { '{0} {1} ({2}%)' -f $t.Name, $size, [Math]::Round($t.V / 1024 * 100 / $TotalKb) } else { '{0} {1}' -f $t.Name, $size }
        }
      }
      default { if ($t.V -ge 100000) { '{0} {1} MB/s' -f $t.Name, ($t.V / 1e6).ToString('0.0', $inv) } }
    }
  }
  return (@($out) -join ', ')
}

# ---- one-second samples: CPU busy % and disk busy % ------------------------------------
# Raw performance counters read twice, one second apart (locale-independent, unlike counter
# names; same idea as /proc/stat and /proc/diskstats on Linux). One wait covers both.
$cpuQuery = "SELECT PercentProcessorTime, Timestamp_Sys100NS FROM Win32_PerfRawData_PerfOS_Processor WHERE Name='_Total'"
$diskQuery = "SELECT Name, PercentIdleTime, Timestamp_Sys100NS FROM Win32_PerfRawData_PerfDisk_PhysicalDisk WHERE Name<>'_Total'"
$sampleA = @{}; $sampleB = @{}
$procA = $null
if ((Want 'cpu') -or (Want 'disk')) {
  $takeSample = {
    param($into)
    if (Want 'cpu') { try { $into.cpu = Get-CimInstance -Query $cpuQuery -ErrorAction Stop } catch { } }
    if (Want 'disk') { try { $into.disk = @(Get-CimInstance -Query $diskQuery -ErrorAction Stop) } catch { } }
  }
  # topprocs: the "before" process snapshot is always taken (it can't be known yet whether anything will be busy).
  if (Want 'topprocs') { try { $procA = Get-ProcSnapshot } catch { $script:groupErrors += "topprocs : $($_.Exception.Message)" } }
  & $takeSample $sampleA; Start-Sleep -Seconds 1; & $takeSample $sampleB
}

if (Want 'cpu') { Try-Group 'cpu' {
  $procs = @(Get-CimInstance Win32_Processor)
  Add-Field 'cpu_model' (($procs[0].Name -replace '\s+', ' ').Trim())
  Add-Field 'cpu_cores' ([int]($procs | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
  $a = $sampleA.cpu; $b = $sampleB.cpu
  $dt = if ($a -and $b) { [double]$b.Timestamp_Sys100NS - [double]$a.Timestamp_Sys100NS } else { 0 }
  if ($dt -gt 0) {
    $busy = 100.0 * (1.0 - (([double]$b.PercentProcessorTime - [double]$a.PercentProcessorTime) / $dt))
    $script:cpuV = [Math]::Round([Math]::Max(0, [Math]::Min(100, $busy)), 1)
    Add-Field 'cpu_pct' $script:cpuV
  } else {
    $script:cpuV = [Math]::Round(($procs | Measure-Object -Property LoadPercentage -Average).Average, 1)
    Add-Field 'cpu_pct' $script:cpuV
  }
} }

if (Want 'ram') { Try-Group 'ram' {
  $totalKb = [double]$os.TotalVisibleMemorySize; $freeKb = [double]$os.FreePhysicalMemory
  $script:ramV = Pct ($totalKb - $freeKb) $totalKb
  Add-Field 'ram_pct' $script:ramV
  Add-Field 'ram_used_mb' ([int](($totalKb - $freeKb) / 1024))
  Add-Field 'ram_total_mb' ([int]($totalKb / 1024))
  $pf = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)
  $pfSize = ($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum
  if ($pfSize -gt 0) { Add-Field 'swap_pct' (Pct ($pf | Measure-Object -Property CurrentUsage -Sum).Sum $pfSize) } else { Add-Field 'swap_pct' 0 }
} }

if (Want 'disk') { Try-Group 'disk' {
  # Activity: 100 - idle %, for the busiest physical disk.
  $busiest = $null
  foreach ($after in @($sampleB.disk)) {
    if (-not $after) { continue }
    $before = @($sampleA.disk) | Where-Object { $_ -and $_.Name -eq $after.Name } | Select-Object -First 1
    if (-not $before) { continue }
    $dt = [double]$after.Timestamp_Sys100NS - [double]$before.Timestamp_Sys100NS
    if ($dt -le 0) { continue }
    $busy = 100.0 * (1.0 - (([double]$after.PercentIdleTime - [double]$before.PercentIdleTime) / $dt))
    $busy = [Math]::Max(0, [Math]::Min(100, $busy))
    if ($null -eq $busiest -or $busy -gt $busiest) { $busiest = $busy }
  }
  if ($null -ne $busiest) { $script:diskV = [Math]::Round($busiest, 1); Add-Field 'disk_busy_pct' $script:diskV }
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 })
  $sys = $disks | Where-Object { $_.DeviceID -eq $env:SystemDrive } | Select-Object -First 1
  if ($sys) {
    Add-Field 'disk_pct' ([int][Math]::Round(100.0 * ($sys.Size - $sys.FreeSpace) / $sys.Size))
    Add-Field 'disk_free_gb' ([Math]::Round($sys.FreeSpace / 1GB, 1))
    Add-Field 'disk_size_gb' ([Math]::Round($sys.Size / 1GB, 1))
  }
  $full = $disks | Sort-Object { ($_.Size - $_.FreeSpace) / $_.Size } -Descending | Select-Object -First 1
  if ($full) {
    Add-Field 'disk_max_pct' ([int][Math]::Round(100.0 * ($full.Size - $full.FreeSpace) / $full.Size))
    Add-Field 'disk_max_mount' $full.DeviceID
  }
} }

# ---- topprocs: only while a metric is over the threshold (otherwise the field is cleared with null) ----
if (Want 'topprocs') { Try-Group 'topprocs' {
  $over = { param($v) ($null -ne $v) -and ([double]$v -gt $TopThreshold) }
  $procB = $null
  if ((& $over $script:cpuV) -or (& $over $script:ramV) -or (& $over $script:diskV)) { $procB = Get-ProcSnapshot }
  $totalKb = [double]$os.TotalVisibleMemorySize
  $coreCount = [double]([int](@(Get-CimInstance Win32_Processor) | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
  $setTop = {
    param($field, $value, $mode, $needsAdmin)
    $line = ''
    if ($procB -and (& $over $value)) {
      $line = Format-TopProcs $mode $procA $procB $coreCount $totalKb
      if ($needsAdmin -and -not $isAdmin) { $line = '' }   # other users' I/O counts are only readable elevated
    }
    if ($line) { $data[$field] = $line } else { $data[$field] = $null }
  }
  if (Want 'cpu') { & $setTop 'top_cpu' $script:cpuV 'cpu' $false }
  if (Want 'ram') { & $setTop 'top_ram' $script:ramV 'ram' $false }
  if (Want 'disk') { & $setTop 'top_disk' $script:diskV 'disk' $true }
} }

if (Want 'time') { Try-Group 'time' {
  Add-Field 'system_time' (Format-Time (Get-Date))
  Add-Field 'timezone' ([TimeZoneInfo]::Local.Id)
  $src = Invoke-Native w32tm.exe @('/query', '/source') | Select-Object -First 1
  if ($LASTEXITCODE -eq 0 -and $src) {
    $src = ($src -replace ',0x[0-9a-fA-F]+', '').Trim()
    Add-Field 'time_source' $src
    Add-Field 'time_synced' (-not ($src -match 'Local CMOS Clock|Free-running System Clock|VM IC Time Synchronization Provider'))
  }
} }

if (Want 'uptime') { Try-Group 'uptime' {
  $boot = $os.LastBootUpTime
  Add-Field 'boot_time' (Format-Time $boot)
  $up = (Get-Date) - $boot
  Add-Field 'uptime' (Format-Duration $up)
  Add-Field 'uptime_h' ([Math]::Round($up.TotalHours, 1))
} }

if (Want 'network') { Try-Group 'network' {
  $route = $null
  if (Get-Command Get-NetRoute -ErrorAction SilentlyContinue) {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
      Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
  }
  if ($route) {
    $idx = $route.InterfaceIndex
    $addr = Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^169\.254\.' } | Select-Object -First 1
    $nic = Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue
    if ($addr) { Add-Field 'ip' $addr.IPAddress }
    if ($nic) { Add-Field 'interface' $nic.Name; Add-Field 'mac' (($nic.MacAddress -replace '-', ':').ToLowerInvariant()) }
    Add-Field 'gateway' $route.NextHop
    $dns = (Get-DnsClientServerAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
    if ($dns) { Add-Field 'dns_servers' ($dns -join ',') }
  } else {
    $nic = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' | Where-Object { $_.DefaultIPGateway } | Select-Object -First 1
    if ($nic) {
      Add-Field 'ip' (@($nic.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0])
      Add-Field 'interface' $nic.Description
      Add-Field 'mac' (([string]$nic.MACAddress) -replace '-', ':').ToLowerInvariant()
      Add-Field 'gateway' (@($nic.DefaultIPGateway)[0])
      if ($nic.DNSServerSearchOrder) { Add-Field 'dns_servers' ($nic.DNSServerSearchOrder -join ',') }
    }
  }
} }

if (Want 'domain') { Try-Group 'domain' {
  $ad = [bool]$cs.PartOfDomain
  Add-Field 'domain_joined' $ad
  if ($ad) { Add-Field 'domain' $cs.Domain.ToLowerInvariant() } else { Add-Field 'workgroup' $cs.Workgroup }
  $roles = @('standalone-workstation', 'member-workstation', 'standalone-server', 'member-server', 'backup-domain-controller', 'primary-domain-controller')
  if ($null -ne $cs.DomainRole -and $cs.DomainRole -lt $roles.Count) { Add-Field 'domain_role' $roles[$cs.DomainRole] }
  $entra = $false
  $ds = Invoke-Native dsregcmd.exe @('/status')
  if ($ds.Count) {
      $entra = [bool]($ds | Select-String -Pattern '^\s*AzureAdJoined\s*:\s*YES' -Quiet)
      Add-Field 'entra_joined' $entra
      $tenant = $ds | Select-String -Pattern '^\s*TenantName\s*:\s*(.+)$' | Select-Object -First 1
      if ($entra -and $tenant) { Add-Field 'entra_tenant' $tenant.Matches[0].Groups[1].Value.Trim() }
  }
  $type = if ($ad -and $entra) { 'hybrid' } elseif ($ad) { 'active-directory' } elseif ($entra) { 'entra' } else { 'none' }
  Add-Field 'domain_type' $type
  if ($ad -and $isAdmin -and $cs.DomainRole -lt 4) {
    # Is the computer's trust with the domain healthy? (nltest works in both 5.1 and 7)
    $nl = Invoke-Native nltest.exe @("/sc_query:$($cs.Domain)") -Merge
    Add-Field 'secure_channel_ok' ([bool](($LASTEXITCODE -eq 0) -and (($nl -join ' ') -match 'NERR_Success')))
  }
} }

if (Want 'users') { Try-Group 'users' {
  $names = @()
  $q = Invoke-Native quser.exe   # exits 1 with no output when nobody is signed in
  if ($q.Count -gt 1) { $names = @($q | Select-Object -Skip 1 | ForEach-Object { (($_.Trim() -replace '^>', '') -split '\s{2,}')[0].Trim() } | Where-Object { $_ } | Sort-Object -Unique) }
  if ($names.Count -eq 0 -and $cs.UserName) { $names = @(($cs.UserName -split '\\')[-1]) }
  Add-Field 'users_logged_in' $names.Count
  if ($names.Count) { Add-Field 'logged_in_users' ($names -join ',') }
} }

if (Want 'health') { Try-Group 'health' {
  Add-Field 'processes' @(Get-Process).Count
  # Automatic services that stopped with an error (delayed-start ones are allowed to be stopped).
  # Exit code 0 means it stopped normally (trigger-start and per-user services do this).
  $stopped = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running' AND ExitCode<>0" |
    Where-Object { -not $_.DelayedAutoStart } | Select-Object -ExpandProperty Name)
  Add-Field 'failed_services' $stopped.Count
  if ($stopped.Count) { Add-Field 'failed_service_names' (($stopped | Select-Object -First 10) -join ',') }
  $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
    (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
  if (-not $reboot) {
    $cn = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -ErrorAction SilentlyContinue).ComputerName
    $acn = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' -ErrorAction SilentlyContinue).ComputerName
    if ($cn -and $acn -and $cn -ne $acn) { $reboot = $true }
  }
  Add-Field 'reboot_required' ([bool]$reboot)
} }

if (Want 'updates') { Try-Group 'updates' {
  $hf = Get-HotFix -ErrorAction SilentlyContinue | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
  if ($hf) { Add-Field 'last_hotfix' $hf.HotFixID; Add-Field 'last_update' (Format-Time $hf.InstalledOn) }
  # Uses the result of Windows Update's last scan (Online = false), so it doesn't download anything.
  $searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
  $searcher.Online = $false
  $res = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  Add-Field 'pending_updates' ([int]$res.Updates.Count)
  $sec = 0
  foreach ($u in $res.Updates) { foreach ($c in $u.Categories) { if ($c.Name -eq 'Security Updates') { $sec++; break } } }
  Add-Field 'security_updates' $sec
} }

if (Want 'security') { Try-Group 'security' {
  if (Get-Command Get-NetFirewallProfile -ErrorAction SilentlyContinue) {
    $fw = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
    if ($fw.Count) {
      $on = @($fw | Where-Object { $_.Enabled -eq $true -or $_.Enabled -eq 1 } | ForEach-Object { $_.Name })
      Add-Field 'firewall_enabled' ($on.Count -eq $fw.Count)
      Add-Field 'firewall_profiles' ($(if ($on.Count) { $on -join ',' } else { 'none' }))
    }
  }
  try {
    $av = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop)
    if ($av.Count) { Add-Field 'av_product' (($av | ForEach-Object { $_.displayName } | Sort-Object -Unique) -join ',') }
  } catch { }  # SecurityCenter2 only exists on client editions
  if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
    try {
      $mp = Get-MpComputerStatus -ErrorAction Stop
      # Only report Defender's numbers when it is the active antivirus (not passive next to another product).
      if (-not $mp.AMRunningMode -or $mp.AMRunningMode -eq 'Normal') {
        if (-not $data.Contains('av_product')) { Add-Field 'av_product' 'Microsoft Defender Antivirus' }
        Add-Field 'av_enabled' ([bool]$mp.AntivirusEnabled)
        Add-Field 'av_realtime' ([bool]$mp.RealTimeProtectionEnabled)
        Add-Field 'av_signature_age_days' ([int]$mp.AntivirusSignatureAge)
      } else { Add-Field 'defender_mode' ([string]$mp.AMRunningMode) }
    } catch { }  # Defender disabled or replaced by another product
  }
  if ($isAdmin) {
    try { Add-Field 'secure_boot' ([bool](Confirm-SecureBootUEFI -ErrorAction Stop)) } catch { }  # throws on BIOS (non-UEFI) machines
    if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
      try { Add-Field 'disk_encrypted' ([string](Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop).ProtectionStatus -eq 'On') } catch { }
    }
  }
} }

# Extra fields: "key=value,key2=value2". Values may reference environment variables:
# %NAME%, ${NAME} or ${NAME:-fallback}. The machine-wide (System) value is read first, straight
# from the registry, so new and changed system variables apply on the next run without a reboot
# (a scheduled task's own environment can be a stale copy). Then this process's environment,
# which covers per-process values such as USERNAME and COMPUTERNAME.
# A field whose value ends up empty is left out.
function Get-EnvValue([string]$Name) {
  $v = [Environment]::GetEnvironmentVariable($Name, 'Machine')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name) }
  return [string]$v
}
function Expand-EnvRefs([string]$Text) {
  $Text = [regex]::Replace($Text, '\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}', {
      param($m)
      $v = Get-EnvValue $m.Groups[1].Value
      if ($v) { $v } else { $m.Groups[2].Value }
    })
  return [regex]::Replace($Text, '%([A-Za-z_][A-Za-z0-9_]*)%', { param($m) Get-EnvValue $m.Groups[1].Value })
}
foreach ($pair in ($Extra -split ',' | Where-Object { $_ -match '=' })) {
  $k, $v = $pair -split '=', 2
  if ($k.Trim()) { Add-Field $k.Trim() (Expand-EnvRefs $v) }
}
if ($groupErrors.Count) { Add-Field 'agent_errors' ($groupErrors -join '; ') }
Add-Field 'agent_version' $Version
Add-Field 'agent_os' 'windows'
Add-Field 'check_ports' $PortsEachRun   # an instruction to the server, not stored as a field

$body = $data | ConvertTo-Json -Compress -Depth 3

# ---- 3. send -------------------------------------------------------------------------------
if ($DryRun) { $data | ConvertTo-Json -Depth 3; exit 0 }
try { $r = Invoke-Api 'POST' '/api/checkin' $body } catch { Stop-Agent "could not reach $Url/api/checkin : $($_.Exception.Message)" }
switch ($r.Status) {
  { $_ -eq 200 -or $_ -eq 201 } {
    $how = if ($r.Status -eq 201) { 'created' } else { 'updated' }
    $lines = @("Checked in as $($data['id']) ($how, $($data.Count) fields).")
    if ($PortsEachRun) {
      try { $res = $r.Body | ConvertFrom-Json } catch { $res = $null }
      if ($res.portCheck -eq 'off') { $lines += '  port checks are turned off on the server (Admin > Port checks)' }
      elseif ($res.ports) { $lines += Format-Ports $res.ports }
      elseif ($res.portCheckError) { $lines += "  port check: $($res.portCheckError)" }
    }
    Write-Log ($lines -join [Environment]::NewLine)
    exit 0
  }
  503 { Write-Log 'Server paused while sending. Nothing saved.'; exit 2 }
  { $_ -eq 401 -or $_ -eq 403 } { Stop-Agent "server refused the API key (HTTP $($r.Status)): $($r.Body)" }
  default { Stop-Agent "check-in failed (HTTP $($r.Status)): $($r.Body)" }
}
