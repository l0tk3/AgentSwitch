# The gate as a Windows service, end to end, on a throw-away Windows machine (the Windows CI runner, which is an
# elevated administrator): docs/gate-simple-v0.md §5, Windows column. Not for a machine anyone uses: it installs and
# removes the service `AgentSwitchGate` and %ProgramData%\AgentSwitch.
#
#   scripts/windows_service_smoke.ps1 -Venv .venv [-Port 18080]
#
# 1. a runtime as `system install --runtime` expects it: python\ (a complete Python with secret-gate installed in it,
#    copied from the Python that created the venv) and VERSIONS;
# 2. `system install` from it (elevated; the owner is this user); the service and its two processes run as
#    NT SERVICE\AgentSwitchGate; the gate home's ACL is SYSTEM, Administrators and the service only;
# 3. as this user (a client of the service): `system status`, `keys`, `enc`, then a request through the proxy with
#    curl and the published CA to a local HTTPS echo site: the site receives the real value, curl sees it redacted;
# 4. `system rotate-key`: the old token stops opening, a new one works (the proxy noticed the new key by itself);
# 5. `system uninstall --delete-keys`: the service and every directory are gone.
param(
    [Parameter(Mandatory = $true)][string]$Venv,
    [int]$Port = 18080,
    [int]$EchoPort = 18443
)

$ErrorActionPreference = 'Stop'
# secret-gate writes UTF-8 to pipes on Windows (cli.utf8_output); read it as such
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$work = Join-Path ([IO.Path]::GetTempPath()) "sg-smoke-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
$venvPython = (Resolve-Path (Join-Path $Venv 'Scripts\python.exe')).Path
$gateCli = (Resolve-Path (Join-Path $Venv 'Scripts\secret-gate.exe')).Path
$package = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$constraints = (Resolve-Path (Join-Path $package '..\mac-app\scripts\python-constraints.txt')).Path
$root = Join-Path $env:ProgramData 'AgentSwitch'
$value = 'smoke-Value-1234567'

function Step([string]$text) { Write-Host "== $text" }
function Fail([string]$text) { throw "smoke failed: $text" }
function Run([string]$exe, [string[]]$arguments, [string]$stdin = $null) {
    # stdout is returned (JSON for some commands); stderr goes to a file and is shown when the command fails
    $err = Join-Path $work 'stderr.txt'
    if ($stdin) { $out = $stdin | & $exe @arguments 2> $err } else { $out = & $exe @arguments 2> $err }
    $text = ($out | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Write-Host $text; Get-Content $err -ErrorAction SilentlyContinue | Write-Host
        Fail "$exe $($arguments -join ' ') exited $LASTEXITCODE"
    }
    return $text
}
function Seal([string]$label) {
    $entry = ConvertTo-Json -Compress @(@{ label = $label; hosts = @("localhost:$EchoPort"); value = $value })
    return (Run $gateCli @('enc', '--batch') $entry | ConvertFrom-Json)[0].token
}
function ThroughProxy([string]$token) {
    $curl = 'C:\Program Files\Git\mingw64\bin\curl.exe'   # OpenSSL: --cacert as everywhere else
    $extra = @()
    if (-not (Test-Path $curl)) { $curl = "$env:SystemRoot\System32\curl.exe"; $extra = @('--ssl-no-revoke') }
    $out = & $curl -sS @extra --max-time 30 --proxy "http://127.0.0.1:$Port" --cacert (Join-Path $root 'gate-public\ca.pem') `
        -H "Authorization: Bearer $token" "https://localhost:$EchoPort/" 2>&1 | Out-String
    return $out
}
function DumpLogs {
    foreach ($log in Get-ChildItem (Join-Path $root 'gate\logs') -Filter '*.log' -ErrorAction SilentlyContinue) {
        Write-Host "---- $($log.Name)"; Get-Content $log.FullName -Tail 60 -ErrorAction SilentlyContinue
    }
}

try {
    Step 'runtime: python\ with secret-gate in it, VERSIONS'
    $runtime = Join-Path $work 'runtime'
    New-Item -ItemType Directory $runtime | Out-Null
    $base = (& $venvPython -c 'import sys; print(sys.base_prefix)').Trim()
    Copy-Item -Recurse $base (Join-Path $runtime 'python')
    $runtimePython = Join-Path $runtime 'python\python.exe'
    Run $runtimePython @('-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-warn-script-location',
        '-c', $constraints, $package) | Out-Null
    New-Item -ItemType Directory (Join-Path $runtime 'secret-gate') | Out-Null
    Copy-Item (Join-Path $package 'AGENTS.md') (Join-Path $runtime 'secret-gate\AGENTS.md')
    Set-Content -Encoding ascii (Join-Path $runtime 'VERSIONS') "secret-gate=0.1.0`nbuilt=$(Get-Date -Format s)"

    Step 'system install (elevated)'
    Write-Host (Run $runtimePython @('-m', 'secret_gate.cli', 'system', 'install', '--runtime', $runtime, '--port', "$Port"))
    $config = Get-Content (Join-Path $root 'gate-service.json') | ConvertFrom-Json
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($config.ownerSid -ne $me) { Fail "ownerSid $($config.ownerSid) is not this user ($me)" }

    Step 'the service and its processes run as NT SERVICE\AgentSwitchGate'
    $service = Get-CimInstance Win32_Service -Filter "Name='AgentSwitchGate'"
    if ($service.StartName -ne 'NT SERVICE\AgentSwitchGate' -or $service.State -ne 'Running') {
        Fail "service: $($service.StartName) $($service.State)"
    }
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($service.ProcessId) AND Name='python.exe'"
    if (@($children).Count -ne 2) { Fail "expected 2 children of the service host (rpc, proxy), got $(@($children).Count)" }
    foreach ($process in @($service.ProcessId) + @($children.ProcessId)) {
        $owner = Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter "ProcessId=$process") -MethodName GetOwner
        if ("$($owner.Domain)\$($owner.User)" -ne 'NT SERVICE\AgentSwitchGate') { Fail "process $process runs as $($owner.Domain)\$($owner.User)" }
    }
    if (-not ($children.CommandLine -match 'gate-runtime\\python\\python.exe')) { Fail 'children do not run the Program Files copy' }

    Step 'the gate home: SYSTEM, Administrators and the service only; nothing inherited'
    $acl = Get-Acl (Join-Path $root 'gate')
    $who = $acl.Access | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique
    $expected = @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM', 'NT SERVICE\AgentSwitchGate')
    if (Compare-Object $who $expected) { Fail "gate ACL: $($who -join ', ')" }
    if (-not $acl.AreAccessRulesProtected) { Fail 'gate ACL inherits from ProgramData' }
    $public = (Get-Acl (Join-Path $root 'gate-public')).Access | ForEach-Object { $_.IdentityReference.Value }
    if ($public -contains 'BUILTIN\Users') { Fail 'gate-public is open to all users' }

    Step 'as this user: status, keys, enc'
    $status = Run $gateCli @('system', 'status', '--json') | ConvertFrom-Json
    if (-not $status.running -or $status.ownerSid -ne $me) { Fail "status: $($status | ConvertTo-Json -Compress)" }
    $keys = Run $gateCli @('keys', '--json') | ConvertFrom-Json
    if (@($keys).Count -ne 1) { Fail 'keys --json' }
    $refused = & $gateCli keygen 2>&1 | Out-String
    if ($LASTEXITCODE -ne 2 -or $refused -notmatch '凭据网关由系统服务管理') { Fail "keygen was not refused: $refused" }

    Step 'proxy substitution through the service, with the published CA'
    $received = Join-Path $work 'received.txt'
    $echo = Start-Process -PassThru -NoNewWindow $venvPython -ArgumentList @((Join-Path $PSScriptRoot 'echo_https.py'), "$EchoPort", $received)
    # the echo site is self-signed: the administrator lists it for the gate (the proxy watches this file)
    Set-Content -Encoding ascii (Join-Path $root 'gate\upstream-insecure.txt') "localhost:$EchoPort"
    Start-Sleep -Seconds 4
    $token = Seal 'echo/pass'
    $out = ThroughProxy $token
    Write-Host $out
    if ($out -notmatch [regex]::Escape('you sent: Bearer [REDACTED:echo/pass]')) { Fail 'the response was not redacted' }
    if (@(Get-Content $received)[-1] -ne "Bearer $value") { Fail 'the site did not receive the real value' }
    if ($out -match [regex]::Escape($value)) { Fail 'the value came back to the client' }

    Step 'rotate-key: the old token stops working, a new one works without restarting the service'
    $before = $keys[0].public
    Write-Host (Run $runtimePython @('-m', 'secret_gate.cli', 'system', 'rotate-key'))
    $after = (Run $gateCli @('keys', '--json') | ConvertFrom-Json)[0].public
    if ($after -eq $before) { Fail 'the key did not change' }
    Start-Sleep -Seconds 4   # the proxy looks at key.priv every 2 s
    $count = @(Get-Content $received).Count
    $old = ThroughProxy $token
    $lines = @(Get-Content $received)
    if ($lines.Count -gt $count -and $lines[-1] -eq "Bearer $value") { Fail 'the old token still opened' }
    $new = ThroughProxy (Seal 'echo/pass')
    if ($new -notmatch [regex]::Escape('[REDACTED:echo/pass]')) { Write-Host $old; Write-Host $new; Fail 'a token sealed to the new key did not work' }
    if (@(Get-Content $received)[-1] -ne "Bearer $value") { Fail 'the site did not receive the real value after rotate-key' }
    Stop-Process -Id $echo.Id -ErrorAction SilentlyContinue

    Step 'uninstall --delete-keys'
    Write-Host (Run $runtimePython @('-m', 'secret_gate.cli', 'system', 'uninstall', '--delete-keys'))
    & "$env:SystemRoot\System32\sc.exe" query AgentSwitchGate | Out-Null
    if ($LASTEXITCODE -ne 1060) { Fail "the service is still registered ($LASTEXITCODE)" }
    foreach ($gone in @((Join-Path $root 'gate'), (Join-Path $root 'gate-public'), (Join-Path $root 'gate-service.json'),
                        (Join-Path $env:ProgramFiles 'AgentSwitch\gate-runtime'))) {
        if (Test-Path $gone) { Fail "$gone is still there" }
    }
    Step 'ok'
}
catch {
    DumpLogs
    throw
}
