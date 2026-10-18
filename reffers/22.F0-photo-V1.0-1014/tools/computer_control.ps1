# Windows PowerShell 5.1; launched by 01_start_preview.bat.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$adbPath = $env:F0_ADB
if (-not $adbPath -or -not (Test-Path -LiteralPath $adbPath)) {
    throw '未找到 adb，请从 01_start_preview.bat 启动。'
}
Add-Type @'
using System.Runtime.InteropServices;
public static class F0Keyboard {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int key);
}
'@
$script:token = [Guid]::NewGuid().ToString('N')

function Send-Control([string]$command) {
    # All command arguments are from a closed list; this program collects no participant data.
    $arguments = @('shell', 'am', 'broadcast', '--user', 'current',
        '-a', 'com.example.f0photo.main.CONTROL', '-p', 'com.example.f0photo.main',
        '--es', 'command', $command, '--es', 'token', $script:token)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $adbPath
    $info.Arguments = $arguments -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(8000)) {
            $process.Kill()
            throw '连接超时；指令可能已送达，请检查眼镜画面，不要盲目重发。'
        }
        $output = $stdout.Result + $stderr.Result
        if ($process.ExitCode -ne 0) { throw "ADB 失败：$output" }
        if ($output -match 'data="(OK [A-Z0-9_]+|ERROR [A-Z0-9_]+)"') {
            return $Matches[1]
        }
        throw '眼镜程序未确认指令。请先部署本次更新，再确认应用在眼镜前台；如仍失败，检查 USB 授权。'
    } finally { $process.Dispose() }
}

try {
    $Host.UI.RawUI.WindowTitle = 'F0-photo - 空格开始，1上一条，2下一条'
    Write-Host '请先在外部显示器上打开背景照片；本程序只控制眼镜文字。'
    Write-Host '本版不输入被试编号、不计时、不记录或导出数据。'
    $state = Send-Control 'prepare'
    if ($state -ne 'OK READY') { throw "程序未就绪：$state。请关闭眼镜应用后重新运行启动脚本。" }
    Write-Host '请保持本控制窗口选中，按空格开始。1 返回上一条；2 进入下一条。'
    Write-Host '共 12 条，可按 1 回看；第 12 条按 2 结束。Esc 关闭控制窗口。'
    $pending = [System.Collections.Generic.Queue[ConsoleKeyInfo]]::new()
    while ($true) {
        if ($pending.Count -gt 0) { $key = $pending.Dequeue() }
        else { $key = [Console]::ReadKey($true) }
        if ($key.Key -eq 'Escape') { Write-Host '控制窗口已关闭；眼镜画面保留。'; exit 0 }
        $command = switch ($key.Key) {
            'Spacebar' { 'start' }
            'D1' { '1' }
            'NumPad1' { '1' }
            'D2' { '2' }
            'NumPad2' { '2' }
            default { '' }
        }
        if (-not $command) { continue }
        $state = Send-Control $command
        if ($state.StartsWith('ERROR ')) { throw "眼镜返回：$state" }
        if ($state -match '^OK SHOWING_(\d+)$') {
            $materialId = [int]$Matches[1]
            if ($materialId -eq 1) { $message = '第 1 / 12 条：按 2 显示下一条；按 1 保持本条。' }
            elseif ($materialId -eq 12) { $message = '第 12 / 12 条：按 1 返回上一条；按 2 结束体验。' }
            else { $message = '第 ' + $materialId + ' / 12 条：按 1 返回上一条；按 2 显示下一条。' }
        } else {
            $message = switch ($state) {
                'OK READY' { '请先按空格开始。' }
                'OK CLEARING' { '正在结束。' }
                'OK FINISHED' { '实验结束' }
                default { $state }
            }
        }
        Write-Host $message
        if ($state -eq 'OK CLEARING' -or $state -eq 'OK FINISHED') {
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ($state -ne 'OK FINISHED' -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 100
                $state = Send-Control 'status'
            }
            if ($state -ne 'OK FINISHED') { throw '结束画面未确认，请检查眼镜是否在前台。' }
            Write-Host '实验结束。本版不生成数据文件。'
            exit 0
        }
        # Suppress auto-repeat from this held key, while retaining other queued keys.
        while (([F0Keyboard]::GetAsyncKeyState([int]$key.Key) -band 0x8000) -ne 0) {
            Start-Sleep -Milliseconds 20
        }
        while ([Console]::KeyAvailable) {
            $queued = [Console]::ReadKey($true)
            if ($queued.Key -ne $key.Key) { $pending.Enqueue($queued) }
        }
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    [void](Read-Host '按回车关闭控制窗口')
    exit 1
}
