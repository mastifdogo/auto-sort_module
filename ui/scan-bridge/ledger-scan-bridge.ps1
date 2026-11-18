<#
Ledger scan bridge (Windows): shares a USB scanner on this PC with Ledger's
Import module, as a network scanner (the eSCL / AirScan protocol). Uses Windows'
own scanner support (WIA) and nothing else: no install.

Run it in Windows PowerShell (right-click the Start button -> Terminal (Admin)
the first time, see below):

    powershell -ExecutionPolicy Bypass -File .\ledger-scan-bridge.ps1
    powershell -ExecutionPolicy Bypass -File .\ledger-scan-bridge.ps1 -Port 8090 -Allow 192.168.1.10
    powershell -ExecutionPolicy Bypass -File .\ledger-scan-bridge.ps1 -List

Then in Ledger: Import -> Scan -> Change scanner -> this PC's address, e.g.
http://192.168.1.25:8090/eSCL (it's printed below when the bridge starts).
Leave the window open while you scan.

The first time, run it as Administrator once: it reserves the port and opens it
in Windows Firewall for your local network (Private profile). After that a
normal window works. By default only computers on your local network may scan;
-Allow narrows that to given addresses (e.g. the Ledger server).
#>
param(
	[int]$Port = 8090,
	[string]$Device = "",
	[string]$Allow = "",
	[switch]$List
)

$ErrorActionPreference = "Stop"
$Version = "1.0"
$WIA_JPEG = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
$WIA_BMP = "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}"
Add-Type -AssemblyName System.Drawing

function Get-Scanners {
	$dm = New-Object -ComObject WIA.DeviceManager
	$out = @()
	foreach ($info in $dm.DeviceInfos) {
		if ($info.Type -eq 1) { # scanner
			$out += [pscustomobject]@{ Id = $info.DeviceID; Name = $info.Properties.Item("Name").Value; Info = $info }
		}
	}
	return $out
}

$scanners = @(Get-Scanners)
if ($List) { $scanners | ForEach-Object { "{0}`t{1}" -f $_.Id, $_.Name }; return }
if ($scanners.Count -eq 0) { throw "Windows finds no scanner. Is it plugged in, switched on, and does it scan with Windows Scan or Windows Fax and Scan?" }
$scanner = if ($Device) { $scanners | Where-Object { $_.Id -eq $Device -or $_.Name -eq $Device } | Select-Object -First 1 } else { $scanners[0] }
if (-not $scanner) { throw "No scanner '$Device'. Try -List." }

function Get-Prop($props, [int]$id) { foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p } }; return $null }
function Set-Prop($props, [int]$id, $value) { $p = Get-Prop $props $id; if ($p) { try { $p.Value = $value } catch { } } }

# What it can do: WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES (3086): 1 feeder, 2 flatbed, 4 duplex.
$dev = $scanner.Info.Connect()
$caps = 2
$capProp = Get-Prop $dev.Properties 3086
if ($capProp) { $caps = [int]$capProp.Value }
$hasFlatbed = ($caps -band 2) -ne 0 -or ($caps -band 1) -eq 0
$hasFeeder = ($caps -band 1) -ne 0
$hasDuplex = ($caps -band 4) -ne 0
$dpi = @(150, 200, 300, 600)
$resProp = Get-Prop $dev.Items.Item(1).Properties 6147
if ($resProp -and $resProp.SubTypeValues) { $dpi = @($resProp.SubTypeValues | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 75 -and $_ -le 1200 }) }
elseif ($resProp -and $resProp.SubTypeMax) { $dpi = @(75, 100, 150, 200, 300, 400, 600 | Where-Object { $_ -ge $resProp.SubTypeMin -and $_ -le $resProp.SubTypeMax }) }
if ($dpi.Count -eq 0) { $dpi = @(300) }

function Scan-Pages($settings) {
	# One page from the glass, or every page in the feeder. -> list of JPEG byte arrays
	$d = $scanner.Info.Connect()
	# WIA_DPS_DOCUMENT_HANDLING_SELECT (3088): 1 feeder, 2 flatbed, 4 duplex; WIA_DPS_PAGES (3096): 0 = all
	if ($settings.Feeder) { Set-Prop $d.Properties 3088 ($(if ($settings.Duplex -and $hasDuplex) { 5 } else { 1 })); Set-Prop $d.Properties 3096 0 }
	elseif ($hasFeeder) { Set-Prop $d.Properties 3088 2 }
	$item = $d.Items.Item(1)
	Set-Prop $item.Properties 6146 ($(if ($settings.Gray) { 2 } else { 1 }))  # intent: 1 colour, 2 grey
	Set-Prop $item.Properties 6147 $settings.Dpi  # horizontal resolution
	Set-Prop $item.Properties 6148 $settings.Dpi  # vertical resolution
	$pages = New-Object System.Collections.ArrayList
	while ($true) {
		try {
			try { $img = $item.Transfer($WIA_JPEG) } catch { $img = $item.Transfer($WIA_BMP) }
		} catch {
			$code = $_.Exception.HResult
			if ($settings.Feeder -and $pages.Count -gt 0) { break }   # feeder empty (0x80210003) after the last page
			if ($code -eq -2145320957) { throw "the document feeder is empty" }
			throw "the scan failed: $($_.Exception.Message)"
		}
		$bytes = [byte[]]$img.FileData.BinaryData
		if (-not ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8)) {
			# not JPEG (BMP, PNG): convert
			$ms = New-Object System.IO.MemoryStream(, $bytes)
			$bmp = [System.Drawing.Image]::FromStream($ms)
			$out = New-Object System.IO.MemoryStream
			$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
			$bmp.Dispose(); $ms.Dispose()
			$bytes = $out.ToArray()
		}
		[void]$pages.Add($bytes)
		if (-not $settings.Feeder) { break }
		if ($pages.Count -ge 200) { break }
	}
	return , $pages
}

function Esc($s) { return [System.Security.SecurityElement]::Escape([string]$s) }

function Caps-Xml {
	$res = ($dpi | ForEach-Object { "<scan:DiscreteResolution><scan:XResolution>$_</scan:XResolution><scan:YResolution>$_</scan:YResolution></scan:DiscreteResolution>" }) -join ""
	$prof = "<scan:SettingProfiles><scan:SettingProfile><scan:ColorModes><scan:ColorMode>RGB24</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode></scan:ColorModes>" +
		"<scan:DocumentFormats><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt></scan:DocumentFormats>" +
		"<scan:SupportedResolutions><scan:DiscreteResolutions>$res</scan:DiscreteResolutions></scan:SupportedResolutions></scan:SettingProfile></scan:SettingProfiles>"
	$x = '<?xml version="1.0" encoding="UTF-8"?><scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">'
	$x += "<pwg:Version>2.0</pwg:Version><pwg:MakeAndModel>$(Esc $scanner.Name)</pwg:MakeAndModel>"
	if ($hasFlatbed) { $x += "<scan:Platen><scan:PlatenInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>3508</scan:MaxHeight>$prof</scan:PlatenInputCaps></scan:Platen>" }
	if ($hasFeeder) { $x += "<scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight>$prof</scan:AdfSimplexInputCaps>$(if ($hasDuplex) { '<scan:AdfDuplexInputCaps/>' })</scan:Adf>" }
	return $x + "</scan:ScannerCapabilities>"
}

function Is-Allowed([System.Net.IPAddress]$ip) {
	if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
	if ([System.Net.IPAddress]::IsLoopback($ip)) { return $true }
	if ($Allow) { return ($Allow -split "," | ForEach-Object { $_.Trim() }) -contains $ip.ToString() }
	$b = $ip.GetAddressBytes()
	if ($b.Length -eq 4) {
		return $b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168) -or ($b[0] -eq 169 -and $b[1] -eq 254) -or ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127)
	}
	return $ip.IsIPv6LinkLocal -or (($b[0] -band 0xFE) -eq 0xFC)
}

function Tag($xml, $name) { if ($xml -match "<(?:\w+:)?$name>([^<]*)</") { return $Matches[1].Trim() }; return "" }

# First run as Administrator: reserve the URL and open the firewall (Private networks only).
$prefix = "http://+:$Port/"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
	# "Everyone" by its SID (WD), so this works on Windows in any language.
	& netsh http add urlacl url=$prefix sddl="D:(A;;GX;;;WD)" 2>$null | Out-Null
	if (-not (Get-NetFirewallRule -DisplayName "Ledger scan bridge" -ErrorAction SilentlyContinue)) {
		New-NetFirewallRule -DisplayName "Ledger scan bridge" -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private,Domain -Action Allow | Out-Null
	}
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
	throw "Can't listen on port $Port. Run this once as Administrator (it reserves the port and opens the firewall), or pick another -Port."
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne "WellKnown" -and $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
Write-Host "Sharing $($scanner.Name)"
Write-Host ("  glass: {0}, feeder: {1}, both sides: {2}, {3} dpi" -f $(if ($hasFlatbed) { "yes" } else { "no" }), $(if ($hasFeeder) { "yes" } else { "no" }), $(if ($hasDuplex) { "yes" } else { "no" }), ($dpi -join "/"))
Write-Host "In Ledger: Import -> Scan -> Change scanner -> http://$($ip):$Port/eSCL"
Write-Host $(if ($Allow) { "Only $Allow may scan." } else { "Only computers on your local network may scan." }) "Close this window to stop."
if ((Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1).NetworkCategory -eq "Public") {
	Write-Host "Note: Windows treats this network as Public, so its firewall blocks the bridge. Make it Private: Settings -> Network & internet -> your network -> Private network."
}

$jobs = @{}
function Reply($ctx, [int]$code, [byte[]]$body = @(), $type = "text/xml", $headers = @{}) {
	$r = $ctx.Response
	$r.StatusCode = $code
	$r.ContentType = $type
	foreach ($k in $headers.Keys) { $r.Headers[$k] = $headers[$k] }
	$r.ContentLength64 = $body.Length
	if ($body.Length) { $r.OutputStream.Write($body, 0, $body.Length) }
	$r.Close()
}
$utf8 = [System.Text.Encoding]::UTF8

while ($listener.IsListening) {
	$ctx = $listener.GetContext() # one request at a time: a scan blocks the others, as a scanner would
	try {
		$req = $ctx.Request
		$path = $req.Url.AbsolutePath.TrimEnd("/")
		Write-Host "$($req.RemoteEndPoint.Address) $($req.HttpMethod) $path"
		if (-not (Is-Allowed $req.RemoteEndPoint.Address)) { Reply $ctx 403 $utf8.GetBytes("not allowed") "text/plain"; continue }
		if ($req.HttpMethod -eq "GET" -and $path -eq "/eSCL/ScannerCapabilities") { Reply $ctx 200 $utf8.GetBytes((Caps-Xml)); continue }
		if ($req.HttpMethod -eq "GET" -and $path -eq "/eSCL/ScannerStatus") {
			Reply $ctx 200 $utf8.GetBytes('<?xml version="1.0" encoding="UTF-8"?><scan:ScannerStatus xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm"><pwg:Version>2.0</pwg:Version><pwg:State>Idle</pwg:State></scan:ScannerStatus>')
			continue
		}
		if ($req.HttpMethod -eq "POST" -and $path -eq "/eSCL/ScanJobs") {
			$xml = (New-Object System.IO.StreamReader($req.InputStream, $utf8)).ReadToEnd()
			$feeder = (Tag $xml "InputSource") -eq "Feeder"
			if ($feeder -and -not $hasFeeder) { Reply $ctx 409; continue }
			$want = [int]("0" + (Tag $xml "XResolution")); if (-not $want) { $want = 300 }
			$best = ($dpi | Sort-Object { [math]::Abs($_ - $want) } | Select-Object -First 1)
			$id = [guid]::NewGuid().ToString()
			$jobs[$id] = @{ Settings = @{ Feeder = $feeder; Duplex = (Tag $xml "Duplex") -eq "true"; Gray = (Tag $xml "ColorMode") -like "Gray*"; Dpi = $best }; Pages = $null; Next = 0 }
			$hostHeader = $req.Headers["Host"]; if (-not $hostHeader) { $hostHeader = "$($ip):$Port" }
			Reply $ctx 201 @() "text/xml" @{ Location = "http://$hostHeader/eSCL/ScanJobs/$id" }
			continue
		}
		if ($path -match "^/eSCL/ScanJobs/([0-9a-f-]{36})(/NextDocument)?$") {
			$id = $Matches[1]
			$job = $jobs[$id]
			if ($req.HttpMethod -eq "DELETE") { $jobs.Remove($id); Reply $ctx 200; continue }
			if (-not $job -or -not $Matches[2]) { Reply $ctx 404; continue }
			if ($null -eq $job.Pages) {
				try { $job.Pages = Scan-Pages $job.Settings } catch {
					$job.Pages = @()
					Write-Host "scan failed: $($_.Exception.Message)"
					Reply $ctx 500 $utf8.GetBytes([string]$_.Exception.Message) "text/plain"
					continue
				}
			}
			if ($job.Next -ge $job.Pages.Count) { Reply $ctx 404; continue }
			$page = [byte[]]$job.Pages[$job.Next]
			$job.Next++
			Reply $ctx 200 $page "image/jpeg"
			continue
		}
		Reply $ctx 404
	} catch {
		Write-Host "error: $($_.Exception.Message)"
		try { Reply $ctx 500 $utf8.GetBytes([string]$_.Exception.Message) "text/plain" } catch { }
	}
}
