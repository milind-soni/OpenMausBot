param(
    [string]$OutputDirectory = "$env:LOCALAPPDATA\OpenMausBot\android-signing"
)

$ErrorActionPreference = 'Stop'
if (-not ("System.Security.Cryptography.ProtectedData" -as [type])) {
    Add-Type -AssemblyName System.Security
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$signingDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$keystorePath = Join-Path $signingDirectory 'openmaus-chief-release.jks'
$protectedPasswordPath = Join-Path $signingDirectory 'password.dpapi'
$alias = 'openmaus-chief'

[System.IO.Directory]::CreateDirectory($signingDirectory) | Out-Null

function New-RandomPassword {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Protect-Password([string]$value) {
    $plain = [Text.Encoding]::UTF8.GetBytes($value)
    $protected = [Security.Cryptography.ProtectedData]::Protect(
        $plain,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllBytes($protectedPasswordPath, $protected)
}

function Unprotect-Password {
    $protected = [IO.File]::ReadAllBytes($protectedPasswordPath)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Text.Encoding]::UTF8.GetString($plain)
}

if ((Test-Path -LiteralPath $keystorePath) -xor (Test-Path -LiteralPath $protectedPasswordPath)) {
    throw "Android signing state is incomplete in $signingDirectory; restore both files before building."
}

if (-not (Test-Path -LiteralPath $keystorePath)) {
    $password = New-RandomPassword
    Protect-Password $password
    & keytool -genkeypair -v -keystore $keystorePath -storetype PKCS12 -alias $alias `
        -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 `
        -dname 'CN=OpenMaus Chief, OU=Mobile, O=SEF Ventures, C=US' `
        -storepass $password -keypass $password
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate the Android release signing key.' }
} else {
    $password = Unprotect-Password
}

$env:OMB_ANDROID_KEYSTORE = $keystorePath
$env:OMB_ANDROID_STORE_PASSWORD = $password
$env:OMB_ANDROID_KEY_ALIAS = $alias
$env:OMB_ANDROID_KEY_PASSWORD = $password

Push-Location $projectRoot
try {
    & .\gradlew.bat assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'The signed Android release build failed.' }
} finally {
    Pop-Location
    Remove-Item Env:OMB_ANDROID_KEYSTORE,Env:OMB_ANDROID_STORE_PASSWORD,Env:OMB_ANDROID_KEY_ALIAS,Env:OMB_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
}

$apk = Join-Path $projectRoot 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw "Signed APK was not produced: $apk" }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apk).Hash.ToLowerInvariant()
"SIGNED_APK=$apk"
"SHA256=$hash"
"SIGNING_KEY=$keystorePath"
