# Sitove kroky instalace vytazene z INSTALL.bat.
#
# Duvod: skladat slozitejsi PowerShell prikaz uvnitr batche (zvlast v
# `for /f ('...')`) znamena escapovat roury i zavorky a je to zdroj chyb,
# ktere se projevi az na cizim pocitaci. Tady je to obycejny skript.
#
#   -Port    port aplikace
#   -Check   jen overi, ze server naslouchá; nic nemeni

param(
    [int]$Port = 5000,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RULE = 'KurzAnalytik'

if ($Check) {
    $l = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $l) {
        Write-Output 'NEBEZI'
    } elseif ($l | Where-Object { $_.LocalAddress -eq '0.0.0.0' }) {
        Write-Output 'OK'
    } else {
        Write-Output ('JEN_LOKALNE ' + ($l[0].LocalAddress))
    }
    exit 0
}

# --- profil site -------------------------------------------------------
# Na Verejne siti Windows zahazuje prichozi spojeni i ping a pravidlo
# firewallu pro profil private/domain se vubec neuplatni. Server je pak
# zvenci nedostupny, aniz by to cokoliv dalo najevo.
$public = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' })
if ($public.Count -gt 0) {
    $names = ($public | ForEach-Object { $_.InterfaceAlias }) -join ', '
    Write-Output "    Sit '$names' je Verejna - prepinam na Soukromou..."
    try {
        $public | Set-NetConnectionProfile -NetworkCategory Private
        Write-Output '    Hotovo - sit je ted Soukroma.'
    } catch {
        Write-Output '    [!] Prepnuti selhalo. Nastaveni - Sit a internet -'
        Write-Output '        vlastnosti site - Soukroma. Bez toho se zvenci nepripojis.'
    }
} else {
    Write-Output '    Sit je Soukroma - v poradku.'
}

# --- firewall ----------------------------------------------------------
foreach ($r in @($RULE, "$RULE ping")) {
    Get-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
try {
    New-NetFirewallRule -DisplayName $RULE -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Private, Domain | Out-Null
    Write-Output "    Port $Port otevren (jen soukroma a domenova sit)."
} catch {
    Write-Output '    [!] Pravidlo firewallu se nepodarilo pridat - server pujde'
    Write-Output '        jen z tohoto pocitace.'
}
# ping je prvni vec, kterou clovek pri hledani chyby zkusi - at nelze
try {
    New-NetFirewallRule -DisplayName "$RULE ping" -Direction Inbound -Action Allow `
        -Protocol ICMPv4 -IcmpType 8 -Profile Private, Domain | Out-Null
} catch { }
