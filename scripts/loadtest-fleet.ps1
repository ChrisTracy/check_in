<#
.SYNOPSIS
  Simulates a fleet of devices checking in continuously, with the numbers of active, aging and
  stale devices (and high CPU, high memory, low disk space...) that you choose.

.DESCRIPTION
  A real load test: every simulated device sends its own POST /api/checkin, with the same kind of
  fields the Windows and Linux agents send, on its own schedule, until you press Ctrl+C.

    Active     devices check in every -IntervalSeconds, spread evenly over the interval like real
               agents (or all at once with -Burst).
    Aging      devices skip check-ins: each one checks in just before it would turn stale, so it
               spends part of every cycle aging. The script runs enough of them (staggered) that
               about -Aging are aging at any moment; the rest of that group shows as active and
               is counted towards -Active.
    Stale      devices check in once (only if they don't exist yet) and then never again.
    Conditions (-HighCpu, -HighMemory, ...) are given to that many of the active devices, and stay
               true on every check-in, so boxes like "cpu_pct > 90 for 10 min" pick them up.
    Ports      -RdpOpen / -RdpClosed (Windows devices, port_3389) and -SshOpen / -SshClosed (Linux
               devices, port_22) are written as fields on those active devices, so the RDP / SSH
               status boxes fill in.
               With -ServerPortChecks those devices also send check_ports, so the server really
               tests ports on the machine running this script (port checks must be on in Admin >
               Port checks). Every simulated device comes from this one address, so the script
               opens a listener on -OpenPort for the "open" devices and points the "closed" ones at
               -ClosedPort, where nothing listens. The server saves its real results as
               port_<OpenPort> / port_<ClosedPort>, and the status line counts them.

  "Active", "aging" and "stale" depend on the dashboard's active threshold (Settings), which the
  script reads from the server. The server decides status from the time of the last check-in, so
  states need time to appear: aging settles after about 2x the threshold, and new stale devices
  turn stale after 2x the threshold. For a quick demo, set the threshold to 1-2 minutes first.

  Every simulated device's id starts with -Prefix (default "LT-") and has sim_group set
  (active, aging, stale), so you can filter them; -Cleanup deletes them all.

  Works in Windows PowerShell 5.1 and PowerShell 7+. The API key needs the User role or higher
  (the normal device API key works).

.EXAMPLE
  .\scripts\loadtest-fleet.ps1 -Url https://checkin.example.com -ApiKey ck_xxx
  # 1,000 active, 50 aging, 25 stale, a few of each condition, every 60 seconds

.EXAMPLE
  .\scripts\loadtest-fleet.ps1 -Url http://localhost:3000 -Active 10000 -Aging 300 -Stale 200 -HighCpu 150 -HighMemory 80 -IntervalSeconds 60

.EXAMPLE
  .\scripts\loadtest-fleet.ps1 -Active 2000 -RdpOpen 300 -RdpClosed 50 -SshOpen 200 -SshClosed 20 -ServerPortChecks
  # 570 devices also have the server test a port on this machine with each check-in

.EXAMPLE
  .\scripts\loadtest-fleet.ps1 -Active 500 -IntervalSeconds 30 -Burst -Minutes 15
  # all 500 at once every 30 seconds, for 15 minutes

.EXAMPLE
  .\scripts\loadtest-fleet.ps1 -Cleanup
  # delete every record whose id starts with "LT-"
#>
param(
  [string]$Url = $(if ($env:CHECKIN_URL) { $env:CHECKIN_URL } else { 'http://localhost:3000' }),
  [string]$ApiKey = $env:CHECKIN_API_KEY,

  # ---- how many devices in each state ----
  [ValidateRange(0, 1000000)][int]$Active = 1000,
  [ValidateRange(0, 1000000)][int]$Aging = 50,
  [ValidateRange(0, 1000000)][int]$Stale = 25,

  # ---- how many of the active devices report each problem (matching the Status box presets) ----
  [ValidateRange(0, 1000000)][int]$HighCpu = 25,           # cpu_pct 92-99
  [ValidateRange(0, 1000000)][int]$HighMemory = 20,        # ram_pct 92-98
  [ValidateRange(0, 1000000)][int]$HighDiskActivity = 10,  # disk_busy_pct 92-100
  [ValidateRange(0, 1000000)][int]$LowDiskSpace = 15,      # disk_max_pct / disk_pct 93-98
  [ValidateRange(0, 1000000)][int]$RebootRequired = 40,    # reboot_required = true
  [ValidateRange(0, 1000000)][int]$NotDomainJoined = 5,    # domain_joined = false
  [ValidateRange(0, 1000000)][int]$FailedServices = 10,    # failed_services 1-3

  # ---- port checks (Windows devices get port_3389, Linux devices port_22) ----
  [ValidateRange(0, 1000000)][int]$RdpOpen = 0,            # port_3389 = open
  [ValidateRange(0, 1000000)][int]$RdpClosed = 0,          # port_3389 = closed
  [ValidateRange(0, 1000000)][int]$SshOpen = 0,            # port_22 = open
  [ValidateRange(0, 1000000)][int]$SshClosed = 0,          # port_22 = closed
  [switch]$ServerPortChecks,                               # those devices also make the server test a real port here
  [ValidateRange(1, 65535)][int]$OpenPort = 45389,         # this script listens here ("open" devices)
  [ValidateRange(1, 65535)][int]$ClosedPort = 45390,       # nothing listens here ("closed" devices)

  # ---- timing ----
  [ValidateRange(1, 86400)][int]$IntervalSeconds = 60,     # how often each active device checks in
  [switch]$Burst,                                          # all active devices at once, instead of spread out
  [ValidateRange(0, 100000)][int]$ActiveMinutes = 0,       # active threshold; 0 = read it from the server
  [ValidateRange(0, 1000000)][int]$Minutes = 0,            # stop after this long; 0 = run until Ctrl+C
  [ValidateRange(1, 3600)][int]$ReportSeconds = 10,        # how often to print a status line

  # ---- other ----
  [string]$Prefix = 'LT-',
  [ValidateRange(1, 10000)][int]$MaxConnections = 256,     # parallel connections to the server
  [ValidateRange(100, 1000000)][int]$MaxInFlight = 20000,  # stop sending new check-ins while this many are waiting
  [switch]$SkipCertificateCheck,                           # for a self-signed HTTPS certificate
  [switch]$Cleanup,                                        # delete every "$Prefix*" record and exit
  [switch]$TopProcesses,                                   # also send top_cpu/top_ram/top_disk text lines (only when over 85%, else null)
  [switch]$DryRun                                          # show the plan and a sample check-in; send nothing
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$base = $Url.TrimEnd('/')
if ($Prefix -notmatch '^[A-Za-z0-9._-]{1,20}$') { throw '-Prefix may only contain letters, digits, dot, dash and underscore (max 20).' }

# ---------------------------------------------------------------- HTTP
Add-Type -AssemblyName System.Net.Http
$isCore = $PSVersionTable.PSEdition -eq 'Core'
if (-not ('CheckinFleetLoad3' -as [type])) {
  # A small C# sender: each check-in is its own async request, timed individually, without
  # blocking the PowerShell loop. (C# 5 syntax so Windows PowerShell 5.1 can compile it.)
  $source = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public class CheckinFleetLoad3 {
  private readonly HttpClient client;
  private readonly string endpoint;
  public ConcurrentQueue<double> Latencies = new ConcurrentQueue<double>();
  public ConcurrentDictionary<string, int> Codes = new ConcurrentDictionary<string, int>();
  public int InFlight;
  public long Sent;
  public string LastError = "";
  // When set, successful replies are read for the server's port check results.
  public bool InspectPorts;
  public ConcurrentDictionary<string, int> PortResults = new ConcurrentDictionary<string, int>();
  public string LastPortError = "";
  private static readonly Regex PortsObject = new Regex("\"ports\"\\s*:\\s*\\{([^}]*)\\}", RegexOptions.Compiled);
  private static readonly Regex PortState = new Regex("\"\\d+\"\\s*:\\s*\"([a-z]+)\"", RegexOptions.Compiled);

  public CheckinFleetLoad3(HttpMessageHandler handler, string endpoint, string apiKey) {
    this.client = new HttpClient(handler);
    this.client.Timeout = TimeSpan.FromSeconds(60);
    if (!String.IsNullOrEmpty(apiKey)) this.client.DefaultRequestHeaders.Add("X-API-Key", apiKey);
    this.endpoint = endpoint;
  }

  private static void Count(ConcurrentDictionary<string, int> d, string k) { d.AddOrUpdate(k, 1, delegate(string key, int v) { return v + 1; }); }

  // Accepts and immediately closes connections, so the server's port checks find this port open.
  public static TcpListener Listen(int port) {
    TcpListener l;
    try {
      // IPv4 and IPv6 together where the machine supports it.
      l = new TcpListener(IPAddress.IPv6Any, port);
      l.Server.DualMode = true;
      l.Start(1000);
    } catch (SocketException) {
      l = new TcpListener(IPAddress.Any, port);
      l.Start(1000);
    }
    AcceptLoop(l);
    return l;
  }
  private static async void AcceptLoop(TcpListener l) {
    while (true) {
      TcpClient c;
      try { c = await l.AcceptTcpClientAsync().ConfigureAwait(false); } catch { return; }
      try { c.Close(); } catch { }
    }
  }

  public static void TrustAllCertificatesLegacy() {
    ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
  }

  public void Send(string json) {
    Interlocked.Increment(ref InFlight);
    Interlocked.Increment(ref Sent);
    Task t = SendAsync(json);
  }

  private async Task SendAsync(string json) {
    Stopwatch sw = Stopwatch.StartNew();
    string code;
    try {
      using (StringContent body = new StringContent(json, Encoding.UTF8, "application/json"))
      using (HttpResponseMessage res = await client.PostAsync(endpoint, body).ConfigureAwait(false)) {
        code = ((int)res.StatusCode).ToString();
        if (res.IsSuccessStatusCode && InspectPorts) {
          string text = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
          Match m = PortsObject.Match(text);
          if (m.Success) {
            foreach (Match p in PortState.Matches(m.Groups[1].Value)) Count(PortResults, p.Groups[1].Value);
          } else if (text.Contains("\"portCheck\":\"off\"")) {
            Count(PortResults, "off");
          } else if (text.Contains("\"portCheckError\"")) {
            Count(PortResults, "refused");
            int i = text.IndexOf("\"portCheckError\"");
            LastPortError = text.Substring(i, Math.Min(200, text.Length - i));
          }
        }
        if (!res.IsSuccessStatusCode) {
          string text = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
          LastError = code + " " + (text.Length > 200 ? text.Substring(0, 200) : text);
        }
      }
    } catch (Exception e) {
      Exception inner = e;
      while (inner.InnerException != null) inner = inner.InnerException;
      code = (e is TaskCanceledException) ? "timeout" : "error";
      LastError = code + ": " + inner.Message;
    }
    sw.Stop();
    Latencies.Enqueue(sw.Elapsed.TotalMilliseconds);
    Codes.AddOrUpdate(code, 1, delegate(string k, int v) { return v + 1; });
    Interlocked.Decrement(ref InFlight);
  }
}
'@
  # PowerShell 7 already references what this needs; Windows PowerShell needs System.Net.Http.
  if ($isCore) { Add-Type -TypeDefinition $source -IgnoreWarnings -WarningAction SilentlyContinue }
  else { Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Net.Http' -IgnoreWarnings -WarningAction SilentlyContinue }
}

$handler = [System.Net.Http.HttpClientHandler]::new()
if ($isCore) {
  $handler.MaxConnectionsPerServer = $MaxConnections
  if ($SkipCertificateCheck) { $handler.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator }
} else {
  # Windows PowerShell 5.1 (.NET Framework) allows only 2 connections per host by default.
  [System.Net.ServicePointManager]::DefaultConnectionLimit = $MaxConnections
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  if ($SkipCertificateCheck) { [CheckinFleetLoad3]::TrustAllCertificatesLegacy() }
}
$sender = [CheckinFleetLoad3]::new($handler, "$base/api/checkin", $ApiKey)

# Plain requests for setup (threshold, existing ids, cleanup).
$apiClient = [System.Net.Http.HttpClient]::new($handler, $false)
$apiClient.Timeout = [TimeSpan]::FromSeconds(120)
if ($ApiKey) { $apiClient.DefaultRequestHeaders.Add('X-API-Key', $ApiKey) }
function Invoke-Api([string]$Method, [string]$Path, [string]$Body) {
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), "$base$Path")
  if ($Body) { $req.Content = [System.Net.Http.StringContent]::new($Body, [System.Text.Encoding]::UTF8, 'application/json') }
  $res = $apiClient.SendAsync($req).GetAwaiter().GetResult()
  $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $res.IsSuccessStatusCode) {
    $msg = try { ($text | ConvertFrom-Json).error } catch { $text }
    throw "$Method $Path failed: HTTP $([int]$res.StatusCode) $msg"
  }
  if ($text) { return $text | ConvertFrom-Json } else { return $null }
}
function Get-ExistingIds {
  $r = Invoke-Api GET '/api/records?idsOnly=1'
  if ($r.PSObject.Properties.Name -contains 'ids') { return $r.ids }
  return @($r.records | ForEach-Object { $_.id })   # older servers return whole records
}

# ---------------------------------------------------------------- cleanup
if ($Cleanup) {
  $ids = @(Get-ExistingIds | Where-Object { $_ -like "$Prefix*" })
  if (-not $ids.Count) { Write-Host "No records starting with '$Prefix'." -ForegroundColor Yellow; return }
  Write-Host "Deleting $($ids.Count) records starting with '$Prefix'..." -ForegroundColor Cyan
  $deleted = 0
  for ($i = 0; $i -lt $ids.Count; $i += 5000) {
    $chunk = $ids[$i..([Math]::Min($i + 4999, $ids.Count - 1))]
    $r = Invoke-Api POST '/api/records/delete' (@{ ids = @($chunk) } | ConvertTo-Json -Compress)
    $deleted += [int]$r.deleted
  }
  Write-Host "Deleted $deleted records." -ForegroundColor Green
  return
}

# ---------------------------------------------------------------- plan
if (-not $ActiveMinutes) {
  try { $ActiveMinutes = [int](Invoke-Api GET '/api/settings').staleMinutes }
  catch { throw "Couldn't read the active threshold from $base ($($_.Exception.Message)). Check -Url and -ApiKey, or pass -ActiveMinutes." }
}
$thresholdSec = $ActiveMinutes * 60
if ($IntervalSeconds -ge $thresholdSec) {
  throw "-IntervalSeconds ($IntervalSeconds) must be shorter than the active threshold ($ActiveMinutes min), or active devices would show as aging between check-ins."
}

# Aging devices check in every $agingCycle seconds: active for the first $thresholdSec, then aging
# until just before they'd turn stale. Staggered, a pool of $agingPool keeps about $Aging aging.
$margin = [Math]::Min(30, [int]($thresholdSec / 2))
$agingCycle = 2 * $thresholdSec - $margin
$agingFraction = ($agingCycle - $thresholdSec) / $agingCycle
$agingPool = if ($Aging) { [int][Math]::Ceiling($Aging / $agingFraction) } else { 0 }
$agingActiveShare = $agingPool - $Aging
$activePool = [Math]::Max(0, $Active - $agingActiveShare)

$conditions = [ordered]@{
  HighCpu = $HighCpu; HighMemory = $HighMemory; HighDiskActivity = $HighDiskActivity; LowDiskSpace = $LowDiskSpace
  RebootRequired = $RebootRequired; NotDomainJoined = $NotDomainJoined; FailedServices = $FailedServices
}
$conditionTotal = ($conditions.Values | Measure-Object -Sum).Sum

# ---------------------------------------------------------------- devices
$rand = [System.Random]::new(4242)   # fixed seed: the same device gets the same site/OS every run
$sites = 'Dallas', 'Austin', 'Chicago', 'Denver', 'Seattle', 'Boston', 'Atlanta', 'Phoenix'
$devices = [System.Collections.Generic.List[object]]::new()
function New-Device([string]$Group, [int]$N, [double]$Period, [double]$FirstDue) {
  $win = $rand.NextDouble() -lt 0.6
  $num = '{0:D5}' -f $N
  $code = switch ($Group) { 'active' { 'ACT' } 'aging' { 'AGE' } default { 'STL' } }
  $d = [pscustomobject]@{
    Id = "$Prefix$code-$num"; Group = $Group; Period = $Period; NextDue = $FirstDue
    Os = if ($win) { 'windows' } else { 'linux' }
    OsName = if ($win) { ('Windows Server 2022 Standard', 'Windows Server 2019 Standard', 'Windows 11 Enterprise')[$rand.Next(3)] } else { ('Ubuntu 24.04.1 LTS', 'Red Hat Enterprise Linux 9.4', 'Debian GNU/Linux 12')[$rand.Next(3)] }
    Site = $sites[$rand.Next($sites.Count)]
    Ip = '10.{0}.{1}.{2}' -f $rand.Next(1, 250), $rand.Next(0, 255), $rand.Next(1, 254)
    RamMb = (8192, 16384, 32768, 65536)[$rand.Next(4)]
    DiskGb = (120, 256, 500, 1000)[$rand.Next(4)]
    DiskPct = $rand.Next(25, 76)
    BootH = $rand.Next(2, 2000)
    Cpu = [double]$rand.Next(5, 40); Ram = [double]$rand.Next(30, 70)
    HighCpu = $false; HighMemory = $false; HighDiskActivity = $false; LowDiskSpace = $false
    RebootRequired = $false; NotDomainJoined = $false; FailedServices = $false
    Rdp = ''; Ssh = ''   # 'open' / 'closed' when this device reports port_3389 / port_22
  }
  $devices.Add($d)
  return $d
}
for ($i = 0; $i -lt $activePool; $i++) {
  $first = if ($Burst) { 0 } else { $i * $IntervalSeconds / [Math]::Max(1, $activePool) }
  [void](New-Device 'active' ($i + 1) $IntervalSeconds $first)
}
for ($i = 0; $i -lt $agingPool; $i++) { [void](New-Device 'aging' ($i + 1) $agingCycle ($i * $agingCycle / $agingPool)) }

# Conditions go to distinct active devices while there are enough, then overlap.
$activeDevices = @($devices | Where-Object Group -eq 'active')
if ($activeDevices.Count) {
  $slot = 0
  foreach ($name in $conditions.Keys) {
    for ($k = 0; $k -lt $conditions[$name]; $k++) { $activeDevices[$slot % $activeDevices.Count].$name = $true; $slot++ }
  }
}

# Ports go to active devices from the other end of the list (so they mix less with the problems
# above). RDP devices are made Windows machines and SSH devices Linux ones.
$portPlan = @(@('Rdp', 'open', $RdpOpen), @('Rdp', 'closed', $RdpClosed), @('Ssh', 'open', $SshOpen), @('Ssh', 'closed', $SshClosed))
$portTotal = $RdpOpen + $RdpClosed + $SshOpen + $SshClosed
if ($portTotal -and $activeDevices.Count) {
  $slot = 0
  foreach ($pp in $portPlan) {
    for ($k = 0; $k -lt $pp[2]; $k++) {
      $d = $activeDevices[$activeDevices.Count - 1 - ($slot % $activeDevices.Count)]; $slot++
      $d.Rdp = ''; $d.Ssh = ''
      $d.($pp[0]) = $pp[1]
      $wantOs = if ($pp[0] -eq 'Rdp') { 'windows' } else { 'linux' }
      if ($d.Os -ne $wantOs) {
        $d.Os = $wantOs
        $d.OsName = if ($wantOs -eq 'windows') { 'Windows Server 2022 Standard' } else { 'Ubuntu 24.04.1 LTS' }
      }
    }
  }
}

# Stale devices: create the ones that don't exist yet (one check-in), then leave them alone.
$staleNew = 0
if ($Stale) {
  $existing = [System.Collections.Generic.HashSet[string]]::new([string[]]@(if (-not $DryRun) { Get-ExistingIds }))
  for ($i = 0; $i -lt $Stale; $i++) {
    $d = New-Device 'stale' ($i + 1) 0 0
    if ($existing.Contains($d.Id)) { $d.NextDue = [double]::PositiveInfinity } else { $staleNew++ }
  }
}

$inv = [System.Globalization.CultureInfo]::InvariantCulture
# "12d 4h 7m", the same text the agents send in uptime.
function Format-Uptime([double]$hours) {
  $t = [TimeSpan]::FromHours($hours)
  if ($t.Days -gt 0) { return '{0}d {1}h {2}m' -f $t.Days, $t.Hours, $t.Minutes }
  if ($t.Hours -gt 0) { return '{0}h {1}m' -f $t.Hours, $t.Minutes }
  return '{0}m' -f $t.Minutes
}
function Get-Body($d, [double]$elapsed) {
  # Normal readings wander a little each time; conditions stay over the box thresholds.
  $d.Cpu = [Math]::Min(60, [Math]::Max(2, $d.Cpu + $rand.Next(-8, 9)))
  $d.Ram = [Math]::Min(80, [Math]::Max(20, $d.Ram + $rand.Next(-4, 5)))
  $cpu = if ($d.HighCpu) { 92 + $rand.NextDouble() * 7 } else { $d.Cpu + $rand.NextDouble() }
  $ram = if ($d.HighMemory) { 92 + $rand.NextDouble() * 6 } else { $d.Ram + $rand.NextDouble() }
  $busy = if ($d.HighDiskActivity) { 92 + $rand.NextDouble() * 8 } else { $rand.NextDouble() * 25 }
  $disk = if ($d.LowDiskSpace) { 93 + $rand.Next(0, 6) } else { $d.DiskPct }
  $failed = if ($d.FailedServices) { 1 + $rand.Next(0, 3) } else { 0 }
  $names = if ($failed) { (@('Spooler', 'W32Time', 'WinRM', 'sshd', 'cron', 'nginx') | Get-Random -Count $failed) -join ',' } else { '' }
  $uptimeH = $d.BootH + $elapsed / 3600
  $fields = [ordered]@{
    id = $d.Id; hostname = $d.Id.ToLower(); os = $d.OsName; agent_os = $d.Os; agent_version = 'loadtest'
    site = $d.Site; ip = $d.Ip; sim_group = $d.Group
    cpu_pct = [Math]::Round($cpu, 1); ram_pct = [Math]::Round($ram, 1); ram_total_mb = $d.RamMb
    disk_pct = $disk; disk_max_pct = $disk; disk_max_mount = $(if ($d.Os -eq 'windows') { 'C:' } else { '/' })
    disk_busy_pct = [Math]::Round($busy, 1); disk_size_gb = $d.DiskGb; disk_free_gb = [Math]::Round($d.DiskGb * (100 - $disk) / 100, 1)
    uptime_h = [Math]::Round($uptimeH, 1); uptime = $(Format-Uptime $uptimeH)
    boot_time = [DateTime]::UtcNow.AddHours(-$uptimeH).ToString('yyyy-MM-ddTHH:mm:ssZ', $inv); reboot_required = [bool]$d.RebootRequired
    domain_joined = -not $d.NotDomainJoined; domain = $(if ($d.NotDomainJoined) { '' } else { 'corp.example.com' })
    failed_services = $failed; failed_service_names = $names
    system_time = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', $inv)
  }
  if ($TopProcesses) {
    # Same shape as the agent's topprocs group: a text line when over 85%, otherwise null (removes the field).
    $pool = @(if ($d.Os -eq 'windows') { 'sqlservr', 'chrome', 'svchost', 'MsMpEng', 'w3wp', 'explorer' } else { 'java', 'postgres', 'nginx', 'python3', 'node', 'rsyslogd' }) | Get-Random -Count 3
    $fields['top_cpu'] = if ($cpu -gt 85) { ($pool | ForEach-Object -Begin { $i = 0 } -Process { $_ + ' ' + [Math]::Max(1, [int]($cpu * (0.5, 0.25, 0.1)[$i])) + '%'; $i++ }) -join ', ' } else { $null }
    $fields['top_ram'] = if ($ram -gt 85) { ($pool | ForEach-Object -Begin { $i = 0 } -Process { $_ + ' ' + [Math]::Round($d.RamMb * $ram / 100 / 1024 * (0.4, 0.2, 0.1)[$i], 1) + ' GB'; $i++ }) -join ', ' } else { $null }
    $fields['top_disk'] = if ($busy -gt 85) { ($pool | ForEach-Object -Begin { $i = 0 } -Process { $_ + ' ' + [Math]::Round(120 * (0.5, 0.3, 0.1)[$i], 1) + ' MB/s'; $i++ }) -join ', ' } else { $null }
  }
  $state = if ($d.Rdp) { $d.Rdp } else { $d.Ssh }
  if ($state) {
    $fields[$(if ($d.Rdp) { 'port_3389' } else { 'port_22' })] = $state
    # The server's real check of this machine: the listener port for "open", the unused one for "closed".
    if ($ServerPortChecks) { $fields['check_ports'] = [string]$(if ($state -eq 'open') { $OpenPort } else { $ClosedPort }) }
  }
  # Hand-built JSON (ConvertTo-Json is slow in Windows PowerShell for thousands per second).
  $parts = foreach ($k in $fields.Keys) {
    $v = $fields[$k]
    $j = if ($null -eq $v) { 'null' }
         elseif ($v -is [bool]) { if ($v) { 'true' } else { 'false' } }
         elseif ($v -is [ValueType]) { ([double]$v).ToString('0.###', $inv) }   # int, double, decimal...
         else { '"' + ([string]$v).Replace('\', '\\').Replace('"', '\"') + '"' }
    '"' + $k + '":' + $j
  }
  return '{' + ($parts -join ',') + '}'
}

# ---------------------------------------------------------------- summary
$fmt = { param($n) '{0:N0}' -f $n }
Write-Host ''
Write-Host "Check-In fleet load test  ->  $base/api/checkin" -ForegroundColor Cyan
Write-Host ("  Active threshold {0} min: active < {0} min since last check-in, aging < {1} min, stale after that" -f $ActiveMinutes, ($ActiveMinutes * 2))
Write-Host ("  Active  {0,7}  check in every {1}s{2}" -f (& $fmt $Active), $IntervalSeconds, $(if ($Burst) { ', all at once' } else { ', spread over the interval' }))
if ($Aging) { Write-Host ("  Aging   {0,7}  from {1} staggered devices that check in every {2:N1} min ({3} of them show as active at any time)" -f (& $fmt $Aging), (& $fmt $agingPool), ($agingCycle / 60), (& $fmt $agingActiveShare)) }
if ($Stale) {
  $staleNote = if ($staleNew) { "{0} new (one check-in now; stale in {1} min), {2} already exist" -f (& $fmt $staleNew), ($ActiveMinutes * 2), (& $fmt ($Stale - $staleNew)) } else { 'all already exist; nothing to send' }
  Write-Host ("  Stale   {0,7}  {1}" -f (& $fmt $Stale), $staleNote)
}
if ($agingActiveShare -gt $Active) { Write-Warning "Active will be about $agingActiveShare, not ${Active}: that many aging-group devices are in the active part of their cycle at any time." }
$cond = ($conditions.GetEnumerator() | Where-Object Value | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '
if ($cond) { Write-Host "  Problems on active devices: $cond" }
if ($portTotal) {
  Write-Host ("  Ports on active devices: RDP open {0}, RDP closed {1}, SSH open {2}, SSH closed {3}{4}" -f $RdpOpen, $RdpClosed, $SshOpen, $SshClosed, $(if ($ServerPortChecks) { " (the server also tests port $OpenPort / $ClosedPort on this machine)" } else { '' }))
  if ($portTotal -gt $activeDevices.Count) { Write-Warning "More port devices ($portTotal) than active devices ($($activeDevices.Count)): later ones replace earlier ones." }
}
if ($conditionTotal -gt $activeDevices.Count -and $activeDevices.Count) { Write-Warning "More problems ($conditionTotal) than active devices ($($activeDevices.Count)): some devices get more than one." }
$perSec = $activePool / $IntervalSeconds + $agingPool / $agingCycle
Write-Host ("  About {0:N0} check-ins/min ({1:N1}/s) to {2:N0} device records. Ctrl+C to stop." -f ($perSec * 60), $perSec, $devices.Count)
if ($Aging) { Write-Host ("  Aging settles after about {0:N0} min (one full cycle)." -f ($agingCycle / 60)) -ForegroundColor DarkGray }
Write-Host ''

if ($DryRun) {
  $sample = $devices | Where-Object { $_.HighCpu } | Select-Object -First 1
  if (-not $sample) { $sample = $devices[0] }
  if ($sample) { Write-Host 'Sample check-in:' -ForegroundColor Cyan; Write-Host (Get-Body $sample 0) }
  return
}
if (-not $devices.Count) { Write-Host 'Nothing to send.'; return }

# ---------------------------------------------------------------- server port checks
$listener = $null
if ($ServerPortChecks -and $portTotal) {
  if ($OpenPort -eq $ClosedPort) { throw '-OpenPort and -ClosedPort must be different.' }
  $pc = (Invoke-Api GET '/api/config').portCheck
  if (-not $pc -or -not $pc.enabled) { throw 'Port checks are turned off on the server. Turn them on in Admin > Port checks, or leave out -ServerPortChecks.' }
  # Something already answering on the "closed" port would make those devices report open.
  $probe = [System.Net.Sockets.TcpClient]::new()
  try { if ($probe.ConnectAsync('127.0.0.1', $ClosedPort).Wait(500)) { throw "Something is listening on port $ClosedPort; pick another with -ClosedPort." } } catch [System.AggregateException] { } finally { $probe.Dispose() }
  try { $listener = [CheckinFleetLoad3]::Listen($OpenPort) }
  catch { Write-Warning "Couldn't listen on port $OpenPort ($($_.Exception.Message)). If another program already answers there, the open checks still work; otherwise pick another with -OpenPort." }
  $sender.InspectPorts = $true
  $portPerMin = ($activeDevices | Where-Object { $_.Rdp -or $_.Ssh }).Count * 60 / $IntervalSeconds
  $limit = if ($pc.PSObject.Properties.Name -contains 'perIpPerMinute') { [int]$pc.perIpPerMinute } else { 300 }
  Write-Host ("  Server port checks: about {0:N0} a minute, all from this machine's address (server limit {1:N0} per address per minute)." -f $portPerMin, $limit)
  if ($portPerMin -gt $limit) { Write-Warning "That's over the server's limit, so some checks will be refused. Raise 'Checks per address per minute' in Admin > Port checks for the test." }
  Write-Host "  If 'open' checks come back as filtered, this machine's firewall is blocking inbound port $OpenPort." -ForegroundColor DarkGray
  Write-Host ''
}
$portTotals = @{}

# ---------------------------------------------------------------- run
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$nextReport = $ReportSeconds
$skipped = 0
$lastSent = 0
$totalCodes = @{}
$allLat = [System.Collections.Generic.List[double]]::new()
function Write-Report([double]$elapsed, [switch]$Final) {
  $window = [System.Collections.Generic.List[double]]::new()
  $l = 0.0
  while ($sender.Latencies.TryDequeue([ref]$l)) { $window.Add($l) }
  $codes = @{}
  foreach ($k in @($sender.Codes.Keys)) {
    $v = 0
    if ($sender.Codes.TryRemove($k, [ref]$v)) { $codes[$k] = $v; $script:totalCodes[$k] = [int]$script:totalCodes[$k] + $v }
  }
  $ok = 0; foreach ($k in $codes.Keys) { if ($k -match '^2') { $ok += $codes[$k] } }
  $bad = ($codes.GetEnumerator() | Where-Object { $_.Key -notmatch '^2' } | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ' '
  $sent = $sender.Sent
  $rate = ($sent - $script:lastSent) / [Math]::Max(1, $ReportSeconds)
  $script:lastSent = $sent
  $pct = { param($arr, $q) if ($arr.Count) { $arr[[Math]::Min($arr.Count - 1, [int]($arr.Count * $q))] } else { 0 } }
  $window.Sort()
  if ($window.Count -lt 200000) { $script:allLat.AddRange($window) }
  $t = [TimeSpan]::FromSeconds([int]$elapsed)
  $line = '{0:hh\:mm\:ss}  sent {1,8:N0} ({2,6:N1}/s)  ok {3,6:N0}  {4}  p50 {5,6:N1} ms  p95 {6,6:N1}  p99 {7,6:N1}  max {8,7:N1}  waiting {9}' -f `
    $t, $sent, $rate, $ok, $(if ($bad) { "FAILED $bad" } else { 'failed 0' }), (& $pct $window 0.5), (& $pct $window 0.95), (& $pct $window 0.99), $(if ($window.Count) { $window[$window.Count - 1] } else { 0 }), $sender.InFlight
  $color = if ($bad) { 'Yellow' } else { 'Gray' }
  Write-Host $line -ForegroundColor $color
  if ($bad -and $sender.LastError) { Write-Host "          last error: $($sender.LastError)" -ForegroundColor DarkYellow }
  if ($sender.InspectPorts) {
    $pr = @{}
    foreach ($k in @($sender.PortResults.Keys)) { $v = 0; if ($sender.PortResults.TryRemove($k, [ref]$v)) { $pr[$k] = $v; $script:portTotals[$k] = [int]$script:portTotals[$k] + $v } }
    if ($pr.Count) {
      $txt = ($pr.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Value)" }) -join ', '
      $warn = $pr.ContainsKey('filtered') -or $pr.ContainsKey('refused') -or $pr.ContainsKey('off') -or $pr.ContainsKey('error')
      Write-Host "          server port checks: $txt" -ForegroundColor $(if ($warn) { 'DarkYellow' } else { 'DarkGray' })
      if ($pr.ContainsKey('refused') -and $sender.LastPortError) { Write-Host "          $($sender.LastPortError)" -ForegroundColor DarkYellow }
      if ($pr.ContainsKey('off')) { Write-Host '          port checks were turned off on the server' -ForegroundColor DarkYellow }
    }
  }
  if ($script:skipped) { Write-Host "          $($script:skipped) check-ins skipped: more than $MaxInFlight were waiting for the server" -ForegroundColor DarkYellow; $script:skipped = 0 }
}

# Devices are kept in quarter-second buckets by when they're due, so each wake-up only touches
# the devices that are due (fast enough for tens of thousands of devices, even in PowerShell 5.1).
$buckets = [System.Collections.Generic.Dictionary[long, System.Collections.Generic.List[object]]]::new()
$cursor = [long]0
function Add-Due($d, [switch]$Initial) {
  # Devices with nothing left to send (stale ones that already exist) have NextDue = infinity.
  if ([double]::IsInfinity($d.NextDue)) { return }
  $k = [long][Math]::Floor($d.NextDue * 4)
  if (-not $Initial) { $k = [Math]::Max($k, $script:cursor + 1) }   # never into a bucket already passed
  $list = $null
  if (-not $buckets.TryGetValue($k, [ref]$list)) { $list = [System.Collections.Generic.List[object]]::new(); $buckets[$k] = $list }
  $list.Add($d)
}
foreach ($d in $devices) { Add-Due $d -Initial }

try {
  while ($true) {
    $elapsed = $clock.Elapsed.TotalSeconds
    if ($Minutes -and $elapsed -ge $Minutes * 60) { break }
    $nowKey = [long][Math]::Floor($elapsed * 4)
    while ($cursor -le $nowKey) {
      $due = $null
      if ($buckets.TryGetValue($cursor, [ref]$due)) {
        [void]$buckets.Remove($cursor)
        foreach ($d in $due) {
          if ($sender.InFlight -ge $MaxInFlight) { $skipped++ }
          else { $sender.Send((Get-Body $d $elapsed)) }
          if ($d.Period -gt 0) {
            $d.NextDue += $d.Period
            if ($d.NextDue -le $elapsed) { $d.NextDue = $elapsed + $d.Period }   # fell behind: don't catch up in a burst
            Add-Due $d
          }                                                                       # stale devices: only once
        }
      }
      $cursor++
    }
    if ($elapsed -ge $nextReport) { Write-Report $elapsed; $nextReport += $ReportSeconds }
    $sleep = [int](250 - ($clock.Elapsed.TotalMilliseconds % 250))
    Start-Sleep -Milliseconds ([Math]::Max(5, $sleep))
  }
} finally {
  # Ctrl+C or -Minutes reached: let in-flight requests finish (up to 10 s) and print totals.
  $wait = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sender.InFlight -gt 0 -and $wait.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 100 }
  Write-Report $clock.Elapsed.TotalSeconds -Final
  $allLat.Sort()
  $okAll = 0; foreach ($k in $totalCodes.Keys) { if ($k -match '^2') { $okAll += $totalCodes[$k] } }
  $badAll = ($totalCodes.GetEnumerator() | Where-Object { $_.Key -notmatch '^2' } | ForEach-Object { "$($_.Key): $($_.Value)" }) -join ', '
  Write-Host ''
  Write-Host ('Total: {0:N0} sent, {1:N0} ok{2} in {3:hh\:mm\:ss}' -f $sender.Sent, $okAll, $(if ($badAll) { ", failed ($badAll)" } else { ', none failed' }), $clock.Elapsed) -ForegroundColor Cyan
  if ($allLat.Count) {
    Write-Host ('Latency: p50 {0:N1} ms, p95 {1:N1} ms, p99 {2:N1} ms, max {3:N1} ms' -f $allLat[[int]($allLat.Count * 0.5)], $allLat[[Math]::Min($allLat.Count - 1, [int]($allLat.Count * 0.95))], $allLat[[Math]::Min($allLat.Count - 1, [int]($allLat.Count * 0.99))], $allLat[$allLat.Count - 1]) -ForegroundColor Cyan
  }
  if ($portTotals.Count) { Write-Host ('Server port checks: ' + (($portTotals.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name) $('{0:N0}' -f $_.Value)" }) -join ', ')) -ForegroundColor Cyan }
  if ($listener) { try { $listener.Stop() } catch { } }
  Write-Host "Simulated records stay on the server; remove them with:  .\scripts\loadtest-fleet.ps1 -Cleanup$(if ($Prefix -ne 'LT-') { " -Prefix $Prefix" })" -ForegroundColor DarkGray
}
