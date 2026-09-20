# One CSV line a second: UDP datagram rates for the whole machine plus the server process's CPU, memory
# and thread count. Written for Windows PowerShell 5.1 (no ternary, no ??).
#
# Why UDPv4 and not a per-process byte counter: measured on 2026-09-19, a 10 MB UDP loopback send moves
# Win32_Process WriteTransferCount by 0 bytes, so per-process network bytes are not available without ETW.
# \UDPv4\Datagrams Sent/sec does count loopback traffic (18.3k/s observed under a 20k/s flood).
param(
  [int]$ServerPid = 0
)
$ErrorActionPreference = 'Continue'
$counters = @('\UDPv4\Datagrams Sent/sec', '\UDPv4\Datagrams Received/sec')
"ts,udpSent,udpRecv,cpuSeconds,workingSet,privateBytes,threads,handles"
Get-Counter -Counter $counters -SampleInterval 1 -Continuous | ForEach-Object {
  $sent = 0
  $recv = 0
  foreach ($s in $_.CounterSamples) {
    if ($s.Path -like '*sent*') { $sent = [int]$s.CookedValue }
    elseif ($s.Path -like '*received*') { $recv = [int]$s.CookedValue }
  }
  $cpu = -1
  $ws = -1
  $pb = -1
  $th = -1
  $ha = -1
  if ($ServerPid -gt 0) {
    try {
      $p = Get-Process -Id $ServerPid -ErrorAction Stop
      $cpu = [math]::Round($p.TotalProcessorTime.TotalSeconds, 3)
      $ws = $p.WorkingSet64
      $pb = $p.PrivateMemorySize64
      $th = $p.Threads.Count
      $ha = $p.HandleCount
    } catch { }
  }
  $ts = [long]([datetime]::UtcNow - [datetime]'1970-01-01').TotalMilliseconds
  "{0},{1},{2},{3},{4},{5},{6},{7}" -f $ts, $sent, $recv, $cpu, $ws, $pb, $th, $ha
}
