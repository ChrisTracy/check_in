<#
.SYNOPSIS
  Fires many simultaneous check-ins at the Check-in API.

.EXAMPLE
  .\scripts\loadtest.ps1                                  # 500 at once to http://localhost:3000
  .\scripts\loadtest.ps1 -Count 2000 -Rounds 5            # 5 waves of 2000
  .\scripts\loadtest.ps1 -ApiKey ck_xxxxx                 # when an API key is set
  .\scripts\loadtest.ps1 -Url https://checkin.contoso.com -Count 1000 -Ids 200

  Works in Windows PowerShell 5.1 and PowerShell 7+.
#>
param(
  [string]$Url = 'http://localhost:3000',
  [int]$Count = 500,                      # requests sent at the same time, per round
  [int]$Rounds = 1,                       # how many waves to send
  [int]$Ids = 0,                          # distinct record ids (0 = one per request)
  [string]$ApiKey = $env:CHECKIN_API_KEY  # or set $env:CHECKIN_API_KEY
)

Add-Type -AssemblyName System.Net.Http
# Windows PowerShell 5.1 (.NET Framework) allows only 2 connections per host by default.
[System.Net.ServicePointManager]::DefaultConnectionLimit = [Math]::Max($Count, 100)

$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(120)
if ($ApiKey) { $client.DefaultRequestHeaders.Add('X-API-Key', $ApiKey) }

$endpoint = ($Url.TrimEnd('/')) + '/api/checkin'
$statuses = 'ok', 'ok', 'ok', 'ok', 'warn', 'error', 'offline'
$sites    = 'Dallas', 'Austin', 'Chicago', 'Denver', 'Seattle'
$idCount  = if ($Ids -gt 0) { $Ids } else { $Count }

Write-Host "POST $endpoint  -  $Count simultaneous requests x $Rounds round(s), $idCount distinct ids" -ForegroundColor Cyan

$grand = [System.Diagnostics.Stopwatch]::StartNew()
$totals = @{ Created = 0; Updated = 0; Failed = 0 }

for ($round = 1; $round -le $Rounds; $round++) {
  # Build every body first so the requests leave as close together as possible.
  $bodies = for ($i = 0; $i -lt $Count; $i++) {
    $n = $i % $idCount
    '{{"id":"ps-device-{0}","status":"{1}","site":"{2}","cpu":{3},"round":{4},"source":"powershell"}}' -f `
      $n, ($statuses | Get-Random), $sites[$n % $sites.Count], (Get-Random -Maximum 101), $round
  }

  $tasks = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($body in $bodies) {
    $content = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, 'application/json')
    $tasks.Add($client.PostAsync($endpoint, $content))
  }
  try { [System.Threading.Tasks.Task]::WaitAll($tasks.ToArray()) } catch { }   # failures are counted below
  $sw.Stop()

  $codes = @{}
  $firstError = $null
  foreach ($t in $tasks) {
    if ($t.IsFaulted -or $t.IsCanceled) {
      $key = 'error'
      if (-not $firstError) { $firstError = if ($t.Exception) { $t.Exception.GetBaseException().Message } else { 'Request timed out' } }
    } else {
      $key = [int]$t.Result.StatusCode
      if ($key -ge 300 -and -not $firstError) { $firstError = "$key " + $t.Result.Content.ReadAsStringAsync().Result }
      $t.Result.Dispose()
    }
    $codes[$key] = 1 + [int]$codes[$key]
  }

  $created = [int]$codes[201]; $updated = [int]$codes[200]
  $failed = $Count - $created - $updated
  $totals.Created += $created; $totals.Updated += $updated; $totals.Failed += $failed
  $rate = [Math]::Round($Count / [Math]::Max($sw.Elapsed.TotalSeconds, 0.001))
  $summary = ($codes.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '  '
  $color = if ($failed) { 'Yellow' } else { 'Green' }
  Write-Host ("Round {0}: {1} requests in {2:N0} ms ({3}/s)   {4}" -f $round, $Count, $sw.Elapsed.TotalMilliseconds, $rate, $summary) -ForegroundColor $color
  if ($firstError) { Write-Host "  First error: $firstError" -ForegroundColor Red }
}

$grand.Stop()
$all = $Count * $Rounds
Write-Host ("Done: {0} requests in {1:N1} s  -  created {2}, updated {3}, failed {4}" -f $all, $grand.Elapsed.TotalSeconds, $totals.Created, $totals.Updated, $totals.Failed) -ForegroundColor Cyan
if ($totals.Failed -and -not $ApiKey) { Write-Host 'Tip: if you see 401s, an API key is set. Pass -ApiKey <key>.' -ForegroundColor DarkYellow }
$client.Dispose()
