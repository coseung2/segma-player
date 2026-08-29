param(
    [Parameter(Mandatory = $true)]
    [int]$ManagerProcessId,
    [string]$SetProperty = '',
    [string]$SetValue = '',
    [string]$InvokeCommand = ''
)

$ErrorActionPreference = 'Stop'

$process = Get-CimInstance Win32_Process -Filter "Name = 'mpv.exe'" |
    Where-Object { $_.ParentProcessId -eq $ManagerProcessId } |
    Select-Object -First 1
if (-not $process) {
    Write-Output 'MPV_NOT_FOUND'
    exit 0
}

$match = [regex]::Match($process.CommandLine, '--input-ipc-server=\\\\\.\\pipe\\([^\s"]+)')
if (-not $match.Success) {
    Write-Output 'PIPE_NOT_FOUND'
    exit 0
}

$pipeName = $match.Groups[1].Value
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None
)
$pipe.Connect(3000)
$writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 4096, $true)
$writer.AutoFlush = $true
$reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false), $false, 4096, $true)

function Invoke-MpvCommand {
    param(
        [Parameter(Mandatory = $true)]
        [array]$Command,
        [Parameter(Mandatory = $true)]
        [string]$RequestId
    )

    $json = @{
        command = $Command
        request_id = $RequestId
    } | ConvertTo-Json -Compress
    $writer.WriteLine($json)
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line) {
            throw 'mpv IPC closed before the response arrived'
        }
        $response = $line | ConvertFrom-Json
        if ($response.request_id -eq $RequestId) {
            return $response
        }
    }
}

if ($SetProperty) {
    $setResponse = Invoke-MpvCommand -Command @('set_property', $SetProperty, $SetValue) -RequestId 'set-property'
    [pscustomobject]@{
        Property = $SetProperty
        Error = $setResponse.error
        Value = ($setResponse.data | ConvertTo-Json -Compress -Depth 8)
    }
}

if ($InvokeCommand) {
    $commandResponse = Invoke-MpvCommand -Command @($InvokeCommand) -RequestId 'invoke-command'
    [pscustomobject]@{
        Command = $InvokeCommand
        Error = $commandResponse.error
        Value = ($commandResponse.data | ConvertTo-Json -Compress -Depth 8)
    }
}

$properties = @(
    'osd-dimensions',
    'dwidth',
    'dheight',
    'display-hidpi-scale',
    'current-window-scale',
    'window-scale',
    'd3d11-composition-size',
    'd3d11-output-mode',
    'vo',
    'video-out-params'
)

foreach ($property in $properties) {
    $requestId = "query-$property"
    $response = Invoke-MpvCommand -Command @('get_property', $property) -RequestId $requestId
    [pscustomobject]@{
        Property = $property
        Error = $response.error
        Value = ($response.data | ConvertTo-Json -Compress -Depth 8)
    }
}

$reader.Dispose()
$writer.Dispose()
$pipe.Dispose()
