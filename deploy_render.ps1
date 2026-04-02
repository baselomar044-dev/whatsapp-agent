param(
    [string]$ServiceName = "whatsapp-agent",
    [string]$Branch = "master",
    [string]$RepoUrl = "",
    [string]$Plan = "starter",
    [string]$Region = "oregon"
)

$RenderApiKey = $env:RENDER_API_KEY
$OwnerId = $env:RENDER_OWNER_ID

if ([string]::IsNullOrWhiteSpace($RenderApiKey)) {
    throw "RENDER_API_KEY environment variable is required."
}

if ([string]::IsNullOrWhiteSpace($OwnerId)) {
    throw "RENDER_OWNER_ID environment variable is required."
}

if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    $RepoUrl = (git config --get remote.origin.url) 2>$null
}

if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    throw "Repo URL is required. Pass -RepoUrl or configure git remote.origin.url."
}

$RepoUrl = $RepoUrl.Trim()

if ($RepoUrl -match '^git@github.com:(.+?)$') {
    $RepoUrl = "https://github.com/$($Matches[1])"
}

if ($RepoUrl.EndsWith('.git')) {
    $RepoUrl = $RepoUrl.Substring(0, $RepoUrl.Length - 4)
}

$SupabaseUrl = $env:SUPABASE_URL
$SupabaseKey = $env:SUPABASE_KEY
$GroqApiKey = $env:GROQ_API_KEY
$DashboardPassword = $env:DASHBOARD_PASSWORD

foreach ($requiredVar in @('SUPABASE_URL', 'SUPABASE_KEY', 'GROQ_API_KEY', 'DASHBOARD_PASSWORD')) {
    if ([string]::IsNullOrWhiteSpace((Get-Item "Env:$requiredVar" -ErrorAction SilentlyContinue).Value)) {
        throw "$requiredVar environment variable is required."
    }
}

$Headers = @{
    "Authorization" = "Bearer $RenderApiKey"
    "Accept"        = "application/json"
    "Content-Type"  = "application/json"
}

$Payload = @{
    type                = "web_service"
    name                = $ServiceName
    ownerId             = $OwnerId
    repo                = $RepoUrl
    branch              = $Branch
    autoDeploy          = "yes"
    rootDir             = ""
    serviceDetails      = @{
        env             = "docker"
        dockerfilePath  = "./Dockerfile"
        dockerContext   = "."
        plan            = $Plan
        region          = $Region
        disk            = @{
            name        = "session-disk"
            mountPath   = "/app/data"
            sizeGB      = 1
        }
    }
    envVars = @(
        @{ key = "PORT";                    value = "3000" },
        @{ key = "DASHBOARD_HOST";          value = "0.0.0.0" },
        @{ key = "DASHBOARD_PORT";          value = "3000" },
        @{ key = "WHATSAPP_SESSION_PATH";   value = "/app/data/session" },
        @{ key = "MANAGER_STORAGE_PATH";    value = "/app/data/storage" },
        @{ key = "SUPABASE_URL";            value = $SupabaseUrl },
        @{ key = "SUPABASE_KEY";            value = $SupabaseKey },
        @{ key = "GROQ_API_KEY";          value = $GroqApiKey },
        @{ key = "DASHBOARD_PASSWORD";      value = $DashboardPassword },
        @{ key = "SEND_TIME";               value = "09:00" },
        @{ key = "MIN_MESSAGES";            value = "30" },
        @{ key = "MAX_MESSAGES";            value = "40" }
    )
}

$JsonPayload = $Payload | ConvertTo-Json -Depth 10
Write-Output "Deploying service '$ServiceName' from repo '$RepoUrl'..."
Write-Output "Payload:"
Write-Output $JsonPayload

Write-Output "`nDeploying to Render..."
try {
    $Response = Invoke-RestMethod -Uri "https://api.render.com/v1/services" -Method POST -Headers $Headers -Body $JsonPayload
    Write-Output "SUCCESS!"
    $Response | ConvertTo-Json -Depth 5
} catch {
    Write-Output "Error: $($_.Exception.Message)"
    if ($_.ErrorDetails) {
        Write-Output "Details: $($_.ErrorDetails.Message)"
    }
}
