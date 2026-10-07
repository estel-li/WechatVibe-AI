@echo off
setlocal DisableDelayedExpansion
set "WV_DIAG_SELF=%~f0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command "$s=[IO.File]::ReadAllText($env:WV_DIAG_SELF,[Text.Encoding]::UTF8); $p=$s -split '(?m)^# WV_DIAG_PS\r?$',2; & ([scriptblock]::Create($p[1]))"
set "WV_DIAG_EXIT=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" pause
exit /b %WV_DIAG_EXIT%
# WV_DIAG_PS
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [IO.Path]::GetDirectoryName($env:WV_DIAG_SELF)
$client = Join-Path $root 'client'
$lines = New-Object 'System.Collections.Generic.List[string]'
$owned = New-Object 'System.Collections.Generic.List[string]'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$id = [Guid]::NewGuid().ToString('N')
$reportName = 'WechatVibe-startup-report-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $id.Substring(0,8) + '.txt'
$exitCode = 0
function Record([string]$message) { $lines.Add($message); Write-Host $message }
function Record-Python([string]$line) {
    $modules=@('ctypes','sqlite3','ssl','psutil','cryptography','zstandard','win32api','pythoncom','numpy','cv2',
      'real_http','real_backend','backend_service','backend_contracts','result_store','node_analysis','wechat_source',
      'account_store','instance_identity','model_source','local_model_source','batch_engine','batch_state',
      'history_browser','profile_state','profile_signals','model_bundle','conversation_selection','chat_server')
    $errors=@('ModuleNotFoundError','ImportError','PermissionError','FileNotFoundError','OSError','TimeoutError',
      'RuntimeError','ValueError','NameError','AttributeError','TypeError','SyntaxError','UnicodeDecodeError',
      'JSONDecodeError','ConnectionRefusedError','MemoryError','OverflowError','other_error')
    $checks=@('python','import','loopback','installation_port','startup_log','historical_startup_error','probe_complete')
    try { $value=$line.Substring(8) | ConvertFrom-Json } catch { Record 'python_probe_output=invalid_record_omitted'; return }
    if ($value.check -notin $checks) { return }
    $clean=[ordered]@{check=[string]$value.check}
    foreach ($property in $value.PSObject.Properties) {
        $name=$property.Name; $item=$property.Value
        switch ($name) {
            'module' { if ($item -is [string] -and $item -in $modules) { $clean[$name]=$item } }
            'missing_module' { if ($item -is [string] -and ($item -in $modules -or $item -eq 'unlisted_module')) { $clean[$name]=$item } }
            'error' { if ($item -is [string] -and $item -in $errors) { $clean[$name]=$item } }
            'status' { if ($item -is [string] -and $item -in @('ok','checking','failed','unknown','skipped_reparse_point','not_present','unreadable','no_allowlisted_traceback_in_tail')) { $clean[$name]=$item } }
            'version' { if ($item -is [string] -and $item -match '^\d{1,2}\.\d{1,2}\.\d{1,3}$') { $clean[$name]=$item } }
            'scope' { if ($item -eq 'latest_two_bounded_error_summaries') { $clean[$name]='latest_two_bounded_error_summaries' } }
            'service_health' { if ($item -eq 'not_requested') { $clean[$name]='not_requested' } }
            'log_modified_utc' { if ($item -is [string] -and $item -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') { $clean[$name]=$item } }
            {$_ -in @('winerror','errno','bits','port','count','log_index')} { if (($item -is [int] -or $item -is [long]) -and $item -ge 0 -and $item -le 65535) { $clean[$name]=$item } }
            'seconds' { if (($item -is [int] -or $item -is [double] -or $item -is [decimal]) -and $item -ge 0 -and $item -le 300) { $clean[$name]=$item } }
            {$_ -in @('tcp_listener','dll_load_failed')} { if ($item -is [bool]) { $clean[$name]=$item } }
            'frames' {
                $frames=@()
                foreach ($frame in @($item) | Select-Object -First 4) {
                    if ($frame.file -is [string] -and ($frame.file -eq 'start-real-client.py' -or $frame.file -in @($modules | ForEach-Object {$_+'.py'})) -and
                        ($frame.line -is [int] -or $frame.line -is [long]) -and $frame.line -ge 1 -and $frame.line -le 1000000) {
                        $frames+=@{file=$frame.file;line=$frame.line}
                    }
                }
                $clean[$name]=$frames
            }
        }
    }
    Record ('WV_DIAG '+($clean | ConvertTo-Json -Depth 4 -Compress))
}
function Safe-Path([string]$file) {
    $cursor=[IO.Path]::GetFullPath($file)
    $boundary=[IO.Path]::GetFullPath($root).TrimEnd('\')
    if (!$cursor.StartsWith($boundary+'\',[StringComparison]::OrdinalIgnoreCase) -and $cursor -ne $boundary) { return $false }
    while ($cursor.Length -ge $boundary.Length) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        }
        if ($cursor -eq $boundary) { break }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    return $true
}
function New-OwnedText([string]$file, [string]$text) {
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $owned.Add($file)
    try { $bytes=$utf8.GetBytes($text); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}
function Writable([string]$directory, [string]$label) {
    if (!(Safe-Path $directory)) { Record "write.$label=skipped_reparse_point"; return }
    if (!(Test-Path -LiteralPath $directory -PathType Container)) { Record "write.$label=not_present"; return }
    $item = Get-Item -LiteralPath $directory -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Record "write.$label=skipped_reparse_point"; return }
    $file = Join-Path $directory ('.wechatvibe-diagnostic-' + $id + '.tmp')
    try {
        $stream = New-Object IO.FileStream($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
        $stream.Dispose()
        Record "write.$label=ok"
    } catch { Record ("write.$label=failed; error=" + $_.Exception.GetType().Name) }
}
function Probe([string]$program, [string]$arguments, [int]$timeout) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$program; $info.Arguments=$arguments; $info.WorkingDirectory=$root
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=$utf8; $info.StandardErrorEncoding=$utf8
    foreach ($key in @('NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE')) { $info.EnvironmentVariables.Remove($key) }
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$info
    $watch=[Diagnostics.Stopwatch]::StartNew()
    try {
        if (!$process.Start()) { throw 'probe_not_started' }
        $buffers=@((New-Object byte[] 4096),(New-Object byte[] 4096))
        $streams=@($process.StandardOutput.BaseStream,$process.StandardError.BaseStream)
        $pending=@($streams[0].ReadAsync($buffers[0],0,4096),$streams[1].ReadAsync($buffers[1],0,4096))
        $captured=New-Object IO.MemoryStream
        $total=0; $stderrPresent=$false; $timedOut=$false; $limited=$false
        while (!$process.HasExited -or $null -ne $pending[0] -or $null -ne $pending[1]) {
            for ($i=0; $i -lt 2; $i++) {
                if ($null -ne $pending[$i] -and $pending[$i].IsCompleted) {
                    $count=$pending[$i].GetAwaiter().GetResult()
                    if ($count -eq 0) { $pending[$i]=$null; continue }
                    $total+=$count
                    if ($i -eq 0 -and $captured.Length -lt 65536) { $captured.Write($buffers[0],0,[Math]::Min($count,65536-$captured.Length)) }
                    if ($i -eq 1) { $stderrPresent=$true }
                    $pending[$i]=$streams[$i].ReadAsync($buffers[$i],0,4096)
                }
            }
            if ($total -gt 131072 -or $watch.ElapsedMilliseconds -gt $timeout) {
                $limited=$total -gt 131072; $timedOut=!$limited
                if (!$process.HasExited) { $process.Kill(); $null=$process.WaitForExit(3000) }
                break
            }
            [Threading.Thread]::Sleep(10)
        }
        $output=$utf8.GetString($captured.ToArray()); $captured.Dispose()
        $code=$null
        if ($process.HasExited) { $code=$process.ExitCode }
        return @{code=$code; timedOut=$timedOut; seconds=[Math]::Round($watch.Elapsed.TotalSeconds,2);
                 output=$output; stderrPresent=$stderrPresent; truncated=($limited -or $total -gt 65536)}
    } finally { $process.Dispose() }
}
$pythonSource = @'
import contextlib, hashlib, importlib, json, os, re, socket, struct, sys, time
from pathlib import Path
root = Path(sys.argv[1]).resolve()
client = root / 'client'
allowed_modules = {'ctypes','sqlite3','ssl','psutil','cryptography','zstandard','win32api','pythoncom','numpy','cv2',
                   'real_http','real_backend','backend_service','backend_contracts','result_store','node_analysis',
                   'wechat_source','account_store','instance_identity','model_source','local_model_source',
                   'batch_engine','batch_state','history_browser','profile_state','profile_signals','model_bundle',
                   'conversation_selection','chat_server'}
allowed_errors = {'ModuleNotFoundError','ImportError','PermissionError','FileNotFoundError','OSError',
                  'TimeoutError','RuntimeError','ValueError','NameError','AttributeError','TypeError',
                  'SyntaxError','UnicodeDecodeError','JSONDecodeError','ConnectionRefusedError',
                  'MemoryError','OverflowError'}
def emit(name, **fields):
    print('WV_DIAG ' + json.dumps({'check':name, **fields}, ensure_ascii=True), flush=True)
def error_fields(exc):
    result={'error':type(exc).__name__ if type(exc).__name__ in allowed_errors else 'other_error'}
    for key in ('winerror','errno'):
        value=getattr(exc,key,None)
        if isinstance(value,int) and 0 <= value <= 65535: result[key]=value
    name=getattr(exc,'name',None)
    if isinstance(name,str): result['missing_module']=name if name in allowed_modules else 'unlisted_module'
    if 'DLL load failed' in str(exc): result['dll_load_failed']=True
    return result
emit('python', version='.'.join(map(str,sys.version_info[:3])), bits=struct.calcsize('P')*8)
for name in ('ctypes','sqlite3','ssl','psutil','cryptography','zstandard','win32api','pythoncom','numpy','cv2'):
    started=time.monotonic()
    emit('import', module=name, status='checking')
    try:
        # Import libraries only. Do not import project modules, create a Backend,
        # start a bridge, read account settings, or query business HTTP endpoints.
        with open(os.devnull,'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            importlib.import_module(name)
        emit('import', module=name, status='ok', seconds=round(time.monotonic()-started,2))
    except Exception as exc:
        emit('import', module=name, status='failed', **error_fields(exc))
try:
    with socket.socket() as listener:
        listener.settimeout(2); listener.bind(('127.0.0.1',0)); listener.listen(1)
        with socket.create_connection(listener.getsockname(),timeout=2) as caller:
            peer,_=listener.accept(); peer.close()
    emit('loopback', status='ok')
except OSError as exc: emit('loopback', status='failed', **error_fields(exc))
try:
    digest=hashlib.sha256(str(client.resolve()).casefold().encode()).hexdigest()
    port=20000+int(digest[:8],16)%40000
    with socket.socket() as connection:
        connection.settimeout(.5)
        occupied=connection.connect_ex(('127.0.0.1',port)) == 0
    emit('installation_port', port=port, tcp_listener=occupied, service_health='not_requested')
except OSError as exc: emit('installation_port', status='unknown', **error_fields(exc))
runtime=client/'.local'/'real-client-runtime'
try:
    if any(p.exists() and (p.is_symlink() or p.is_junction()) for p in (client/'.local',runtime)):
        emit('startup_log', status='skipped_reparse_point')
    elif runtime.is_dir():
        logs=sorted((p for p in runtime.glob('bridge-*.log') if p.is_file() and not p.is_symlink()),
                    key=lambda p:p.stat().st_mtime, reverse=True)[:2]
        emit('startup_log', count=len(logs), scope='latest_two_bounded_error_summaries')
        for number,log in enumerate(logs,1):
            stamp=time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(log.stat().st_mtime))+'Z'
            with log.open('rb') as stream:
                stream.seek(max(0,log.stat().st_size-65536)); tail=stream.read(65536).decode('utf-8',errors='replace')
            active=False; frames=[]; errors=0
            for line in tail.splitlines():
                if line == 'Traceback (most recent call last):': active=True; frames=[]; continue
                if not active: continue
                match=re.match(r'^\s+File "[^"]*[/\\]([A-Za-z0-9_\-]+\.py)", line (\d+)',line)
                if match:
                    filename=match[1]
                    if filename[:-3] in allowed_modules or filename == 'start-real-client.py':
                        frames.append({'file':filename,'line':min(int(match[2]),1000000)})
                    continue
                match=re.match(r'^([A-Za-z]+Error):',line)
                if match and match[1] in allowed_errors:
                    fields={'error':match[1],'frames':frames[-4:]}
                    missing=re.search(r"No module named '([A-Za-z0-9_.]+)'",line)
                    if missing: fields['missing_module']=missing[1] if missing[1] in allowed_modules else 'unlisted_module'
                    win=re.search(r'\[WinError (\d{1,5})\]',line)
                    if win: fields['winerror']=int(win[1])
                    if 'DLL load failed' in line: fields['dll_load_failed']=True
                    emit('historical_startup_error', log_index=number, log_modified_utc=stamp, **fields)
                    errors+=1; active=False
                    if errors >= 6: break
            if not errors: emit('historical_startup_error',log_index=number,log_modified_utc=stamp,status='no_allowlisted_traceback_in_tail')
    else: emit('startup_log', status='not_present')
except OSError as exc: emit('startup_log', status='unreadable', **error_fields(exc))
emit('probe_complete', status='ok')
'@
try {
    Record 'WechatVibe Startup Diagnostics v1'
    Write-Host '正在检查启动环境，通常一分钟内完成。不会启动客户端或读取聊天。'
    Record ('time='+(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'))
    Record ('windows='+[Environment]::OSVersion.Version.ToString()+'; os64='+[Environment]::Is64BitOperatingSystem)
    Record ('install_path_length='+$root.Length+'; contains_non_ascii='+($root -match '[^\x00-\x7f]'))
    try { Record ('filesystem='+(New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))).DriveFormat) }
    catch { Record 'filesystem=unknown' }
    foreach ($name in @('whoami.exe','icacls.exe')) {
        Record ('windows_tool.'+$name+'.present='+(Test-Path -LiteralPath (Join-Path $env:SystemRoot ('System32\'+$name)) -PathType Leaf))
    }
    Record 'scope=local checks only; no chat, account configuration, key or full-log export'
    foreach ($name in @('WECHATVIBE_PYTHON','WECHATVIBE_NODE','PYTHONHOME','PYTHONPATH','NODE_OPTIONS','NODE_PATH','HTTP_PROXY','HTTPS_PROXY')) {
        Record ('environment.'+$name+'.present='+[bool][Environment]::GetEnvironmentVariable($name))
    }
    if (!(Test-Path -LiteralPath (Join-Path $root 'WechatVibe.exe') -PathType Leaf)) {
        Record 'placement=invalid; put this BAT beside WechatVibe.exe and run it again'
        throw 'wrong_placement'
    }
    if (!(Safe-Path $client)) { Record 'installation=redirected_client_directory; probes_skipped'; throw 'unsafe_layout' }
    $package=Join-Path $client 'package.json'
    if ((Safe-Path $package) -and (Test-Path -LiteralPath $package -PathType Leaf) -and (Get-Item -LiteralPath $package).Length -le 65536) {
        try { $version=([IO.File]::ReadAllText($package) | ConvertFrom-Json).version
              if ($version -is [string] -and $version.Length -le 80 -and $version -match '^(\d{1,3}\.\d{1,3}\.\d{1,3})(?:[-+][A-Za-z0-9.-]+)?$') { Record ('package_version='+$Matches[1]) } }
        catch { Record 'package_version=unreadable' }
    }
    if (Safe-Path (Join-Path $root 'WechatVibe.exe')) {
        $version=(Get-Item -LiteralPath (Join-Path $root 'WechatVibe.exe')).VersionInfo.FileVersion
        if ($version -match '^\d{1,5}(?:\.\d{1,5}){2,3}$') { Record ('exe_version='+$version) }
    }
    $required=@('WechatVibe.exe','client\package.json',
      'client\scripts\start-real-client.py','client\bridge\chat_server.py',
      'client\bridge\real_http.py','client\bridge\real_backend.py',
      'client\runtime\python\python.exe','client\runtime\python\python314.dll',
      'client\runtime\python\python314._pth','client\runtime\python\vcruntime140.dll',
      'client\runtime\python\vcruntime140_1.dll','client\runtime\node\node.exe')
    foreach ($relative in $required) {
        $file=Join-Path $root $relative
        if (!(Safe-Path $file)) { Record ('file.'+$relative+'=REPARSE_POINT') }
        elseif (Test-Path -LiteralPath $file -PathType Leaf) { Record ('file.'+$relative+'=present; bytes='+(Get-Item -LiteralPath $file).Length) }
        else { Record ('file.'+$relative+'=MISSING') }
    }
    foreach ($relative in @('WechatVibe.exe','client\scripts\start-real-client.py')) {
        $file=Join-Path $root $relative
        if ((Safe-Path $file) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
            $hash=[Security.Cryptography.SHA256]::Create(); $stream=[IO.File]::OpenRead($file)
            try { Record ('sha256.'+$relative+'='+[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()) }
            finally { $stream.Dispose(); $hash.Dispose() }
        }
    }
    Writable $root 'install'; Writable $client 'client'
    $local=Join-Path $client '.local'
    if ((Test-Path -LiteralPath $local) -and (((Get-Item -LiteralPath $local -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Record 'write.local=skipped_reparse_point'
    } else {
        Writable $local 'local'
        Writable (Join-Path $local 'real-client-runtime') 'runtime'
        Writable (Join-Path $local 'tauri-webview') 'shell'
    }
    $python=Join-Path $client 'runtime\python\python.exe'
    if ((Safe-Path $python) -and (Test-Path -LiteralPath $python -PathType Leaf)) {
        $probeFile=Join-Path ([IO.Path]::GetTempPath()) ('wechatvibe-diag-'+$id+'.py')
        New-OwnedText $probeFile $pythonSource
        Record 'python_probe=running; maximum 45 seconds'
        $result=Probe $python ('-I -B -X utf8 "'+$probeFile+'" "'+$root+'"') 45000
        Record ('python_process.exit='+$result.code+'; timeout='+$result.timedOut+'; seconds='+$result.seconds+'; stderr_present='+$result.stderrPresent+'; truncated='+$result.truncated)
        if ($null -ne $result.code) { Record ('python_process.exit_hex=0x'+([BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$result.code),0)).ToString('X8')) }
        foreach ($line in ($result.output -split '\r?\n')) {
            if ($line.StartsWith('WV_DIAG ') -and $line.Length -le 2048) {
                Record-Python $line
            }
        }
    }
    $node=Join-Path $client 'runtime\node\node.exe'
    if ((Safe-Path $node) -and (Test-Path -LiteralPath $node -PathType Leaf)) {
        $result=Probe $node '--version' 10000
        Record ('node_process.exit='+$result.code+'; timeout='+$result.timedOut+'; seconds='+$result.seconds)
        if ($result.output.Trim() -match '^v\d+\.\d+\.\d+$') { Record ('node_version='+$result.output.Trim()) }
    }
    Record 'complete=checks_finished; this does not prove the application can start'
} catch {
    $exitCode=1
    Record ('diagnostic_error='+$_.Exception.GetType().Name+'; diagnostic_line='+$_.InvocationInfo.ScriptLineNumber)
} finally {
    foreach ($file in $owned) { if ([IO.File]::Exists($file)) { try { [IO.File]::Delete($file) } catch { Record 'probe_cleanup=failed' } } }
    $saved=$false
    foreach ($directory in @($root,[IO.Path]::GetTempPath())) {
        try {
            if ($directory -eq $root -and !(Safe-Path $directory)) { continue }
            $report=Join-Path $directory $reportName
            $stream=[IO.File]::Open($report,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try { $bytes=$utf8.GetBytes(($lines -join "`r`n")+"`r`n"); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
            Write-Host ''; Write-Host '请只发送下面的诊断报告文件：'; Write-Host $report
            $saved=$true; break
        } catch { }
    }
    if (!$saved) { Write-Host 'Report could not be saved. Copy the diagnostic text shown above.'; $exitCode=1 }
}
exit $exitCode
