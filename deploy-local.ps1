# Deploy incident-stream-processor to Azure Container Apps from local machine
# Run from: C:\SolEng\POC\incident-stream-processor
#
# Option A - load secrets from .env (recommended):
#   .\deploy-local.ps1 -UseLocalSettings
#
# Option B - pass parameters explicitly:
#   .\deploy-local.ps1 `
#     -MongoUri "mongodb+srv://..." `
#     -DtEnvUrl "https://your-env.apps.dynatrace.com" `
#     -DtClientId "dt0s02...." `
#     -DtClientSecret "dt0s02...." `
#     -GithubToken "ghp_..." `
#     -GithubWebhookSecret "your-webhook-secret" `
#     -CopilotBillingUser "lavanyapamula-lp" `
#     -CopilotBillingAccount "user" `
#     -JiraBaseUrl "https://your-org.atlassian.net" `
#     -JiraEmail "bot@company.com" `
#     -JiraApiToken "..." `
#     -JiraProjectKey "FPI" `
#     -JiraIncidentIssuetypeId "10037" `
#     -JiraServiceNameFieldId "customfield_10089"
#
# Any explicit -Param always wins over the .env value, so -UseLocalSettings plus a
# one-off override (e.g. .\deploy-local.ps1 -UseLocalSettings -ImageTag v2) works too.

param(
    [string]$ResourceGroup = "rg-freight-planning",
    [string]$Location = "eastus",
    [string]$ContainerAppName = "incident-stream-proc",
    [string]$ContainerAppsEnvironment = "cae-freight-planning",
    [string]$AcrName = "acrfreightplanning",
    [string]$ImageTag = "v$(Get-Date -Format 'yyyyMMdd-HHmm')",
    [int]$TargetPort = 3000,

    [string]$FunctionAppName = "incident-remediation-agent-fn",
    [string]$StorageAccountName = "stincidentremediation",

    [switch]$UseLocalSettings,
    [string]$EnvFilePath = ".env",

    [string]$MongoUri,

    [string]$MongoDbName = "incident_management",
    [string]$MongoCollection = "service_error_logs",

    [string]$FunctionAppUrl = "",
    [string]$FunctionAppKey = "",

    [string]$EnableDynatracePoller = "false",
    [string]$DtEnvUrl = "",
    [string]$DtClientId = "",
    [string]$DtClientSecret = "",

    [string]$CheckpointStorageConnectionString = "",
    [string]$CheckpointContainer = "dynatrace-poller-checkpoints",
    [string]$CheckpointBlob = "checkpoint.json",

    [string]$DynatraceWebhookToken = "",
    [string]$LogLevel = "info",
    [string]$GithubWebhookSecret = "",
    [string]$GithubToken = "",
    [string]$GithubOrg = "",
    [string]$CopilotBillingMode = "ai_credits",
    [string]$CopilotBillingUser = "",
    [string]$CopilotBillingAccount = "user",
    [string]$CopilotModel = "claude-sonnet-5",
    [string]$CopilotCreditUsdRate = "0.01",
    [string]$InternalApiKey = "",

    [string]$JiraBaseUrl = "",
    [string]$JiraEmail = "",
    [string]$JiraApiToken = "",
    [string]$JiraProjectKey = "",
    [string]$JiraIncidentIssuetypeId = "",
    [string]$JiraServiceNameFieldId = "",
    [string]$JiraServiceDeskId = "",
    [string]$JiraRequestTypeId = "",

    [string]$PollerServiceNames = "freight-planning-admin-service,freight-planning-transaction-service,freight-planning-invoice-service",

    # Application log poller (Azure Log Analytics queried directly - replaces the Dynatrace poller)
    [string]$LogWorkspaceId = "680281e8-a265-4e55-99f4-2fbb47a613d8",
    [string]$ContainerAppNames = "freight-planning-admin-svc,freight-planning-transaction-svc,freight-planning-invoice-svc",
    [string]$AppLogCollection = "service_error_logs",
    [string]$AppLogCheckpointContainer = "application-log-poller-checkpoints",
    [string]$AppLogCheckpointBlob = "checkpoint.json",

    [switch]$SkipBuild,
    [switch]$SkipInfrastructure
)

$ErrorActionPreference = "Stop"

# Captured once so Resolve-Setting can tell "explicitly passed on the command line" apart from
# "left at its PowerShell default" — a bare truthiness check on a non-empty default (e.g.
# $EnableDynatracePoller = "false") would otherwise always win over -UseLocalSettings/.env.
$script:CliBoundParams = $PSBoundParameters

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Import-DotEnvValues {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        throw ".env not found: $Path"
    }
    # Read raw text (not Get-Content) so a final line with no trailing newline isn't silently dropped.
    $raw = [System.IO.File]::ReadAllText($Path)
    $values = @{}
    foreach ($line in ($raw -split "`r`n|`n")) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $parts = $line -split '=', 2
        $name = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"').Trim("'")
        if ($name) { $values[$name] = $value }
    }
    return $values
}

function Resolve-Setting {
    param(
        [string]$Name,
        [string]$ParamName,
        [string]$ParamValue,
        [hashtable]$LocalValues
    )
    if ($script:CliBoundParams.ContainsKey($ParamName)) { return $ParamValue }
    if ($LocalValues -and $LocalValues.ContainsKey($Name) -and $LocalValues[$Name]) { return $LocalValues[$Name] }
    return $ParamValue
}

function Test-AzResourceExists {
    param([scriptblock]$AzCommand)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $AzCommand 2>$null | Out-Null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap
    return $ok
}

function Get-ContainerAppEnvArgs {
    param(
        [hashtable]$Env
    )
    $args = @()
    foreach ($key in ($Env.Keys | Sort-Object)) {
        $value = $Env[$key]
        if ($null -ne $value -and $value -ne "") {
            $args += "${key}=$value"
        }
    }
    return $args
}

function Get-ContainerAppEnvValue {
    param(
        [string]$Name
    )

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $value = az containerapp show `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --query "properties.template.containers[0].env[?name=='$Name'].value | [0]" -o tsv 2>$null
    $ErrorActionPreference = $prevEap
    return $value
}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "Container App Deployment - incident-stream-processor" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

$localValues = $null
if ($UseLocalSettings) {
    Write-Host "Loading settings from $EnvFilePath..." -ForegroundColor Yellow
    $localValues = Import-DotEnvValues -Path $EnvFilePath
    Write-Host "Loaded $EnvFilePath ($($localValues.Count) value(s))" -ForegroundColor Green
    Write-Host ""
}

$MongoUri                          = Resolve-Setting -Name "MONGO_URI" -ParamName "MongoUri" -ParamValue $MongoUri -LocalValues $localValues
$MongoDbName                       = Resolve-Setting -Name "MONGO_DB_NAME" -ParamName "MongoDbName" -ParamValue $MongoDbName -LocalValues $localValues
$MongoCollection                   = Resolve-Setting -Name "MONGO_COLLECTION" -ParamName "MongoCollection" -ParamValue $MongoCollection -LocalValues $localValues
$EnableDynatracePoller              = Resolve-Setting -Name "ENABLE_DYNATRACE_POLLER" -ParamName "EnableDynatracePoller" -ParamValue $EnableDynatracePoller -LocalValues $localValues
$DtEnvUrl                          = Resolve-Setting -Name "DT_ENV_URL" -ParamName "DtEnvUrl" -ParamValue $DtEnvUrl -LocalValues $localValues
$DtClientId                        = Resolve-Setting -Name "DT_CLIENT_ID" -ParamName "DtClientId" -ParamValue $DtClientId -LocalValues $localValues
$DtClientSecret                    = Resolve-Setting -Name "DT_CLIENT_SECRET" -ParamName "DtClientSecret" -ParamValue $DtClientSecret -LocalValues $localValues
$CheckpointStorageConnectionString = Resolve-Setting -Name "CHECKPOINT_STORAGE_CONNECTION_STRING" -ParamName "CheckpointStorageConnectionString" -ParamValue $CheckpointStorageConnectionString -LocalValues $localValues
$DynatraceWebhookToken             = Resolve-Setting -Name "DYNATRACE_WEBHOOK_TOKEN" -ParamName "DynatraceWebhookToken" -ParamValue $DynatraceWebhookToken -LocalValues $localValues
$LogLevel                          = Resolve-Setting -Name "LOG_LEVEL" -ParamName "LogLevel" -ParamValue $LogLevel -LocalValues $localValues
$GithubWebhookSecret               = Resolve-Setting -Name "GITHUB_WEBHOOK_SECRET" -ParamName "GithubWebhookSecret" -ParamValue $GithubWebhookSecret -LocalValues $localValues
$GithubToken                       = Resolve-Setting -Name "GITHUB_TOKEN" -ParamName "GithubToken" -ParamValue $GithubToken -LocalValues $localValues
$GithubOrg                         = Resolve-Setting -Name "GITHUB_ORG" -ParamName "GithubOrg" -ParamValue $GithubOrg -LocalValues $localValues
$CopilotBillingMode                = Resolve-Setting -Name "COPILOT_BILLING_MODE" -ParamName "CopilotBillingMode" -ParamValue $CopilotBillingMode -LocalValues $localValues
$CopilotBillingUser                = Resolve-Setting -Name "COPILOT_BILLING_USER" -ParamName "CopilotBillingUser" -ParamValue $CopilotBillingUser -LocalValues $localValues
$CopilotBillingAccount             = Resolve-Setting -Name "COPILOT_BILLING_ACCOUNT" -ParamName "CopilotBillingAccount" -ParamValue $CopilotBillingAccount -LocalValues $localValues
$CopilotModel                      = Resolve-Setting -Name "COPILOT_MODEL" -ParamName "CopilotModel" -ParamValue $CopilotModel -LocalValues $localValues
$CopilotCreditUsdRate              = Resolve-Setting -Name "COPILOT_CREDIT_USD_RATE" -ParamName "CopilotCreditUsdRate" -ParamValue $CopilotCreditUsdRate -LocalValues $localValues
$InternalApiKey                    = Resolve-Setting -Name "INTERNAL_API_KEY" -ParamName "InternalApiKey" -ParamValue $InternalApiKey -LocalValues $localValues
$JiraBaseUrl                       = Resolve-Setting -Name "JIRA_BASE_URL" -ParamName "JiraBaseUrl" -ParamValue $JiraBaseUrl -LocalValues $localValues
$JiraEmail                         = Resolve-Setting -Name "JIRA_EMAIL" -ParamName "JiraEmail" -ParamValue $JiraEmail -LocalValues $localValues
$JiraApiToken                      = Resolve-Setting -Name "JIRA_API_TOKEN" -ParamName "JiraApiToken" -ParamValue $JiraApiToken -LocalValues $localValues
$JiraProjectKey                    = Resolve-Setting -Name "JIRA_PROJECT_KEY" -ParamName "JiraProjectKey" -ParamValue $JiraProjectKey -LocalValues $localValues
$JiraIncidentIssuetypeId           = Resolve-Setting -Name "JIRA_INCIDENT_ISSUETYPE_ID" -ParamName "JiraIncidentIssuetypeId" -ParamValue $JiraIncidentIssuetypeId -LocalValues $localValues
$JiraServiceNameFieldId            = Resolve-Setting -Name "JIRA_SERVICE_NAME_FIELD_ID" -ParamName "JiraServiceNameFieldId" -ParamValue $JiraServiceNameFieldId -LocalValues $localValues
$JiraServiceDeskId                 = Resolve-Setting -Name "JIRA_SERVICE_DESK_ID" -ParamName "JiraServiceDeskId" -ParamValue $JiraServiceDeskId -LocalValues $localValues
$JiraRequestTypeId                 = Resolve-Setting -Name "JIRA_REQUEST_TYPE_ID" -ParamName "JiraRequestTypeId" -ParamValue $JiraRequestTypeId -LocalValues $localValues
$PollerServiceNames                = Resolve-Setting -Name "POLLER_SERVICE_NAMES" -ParamName "PollerServiceNames" -ParamValue $PollerServiceNames -LocalValues $localValues
$LogWorkspaceId                    = Resolve-Setting -Name "LOG_WORKSPACE_ID" -ParamName "LogWorkspaceId" -ParamValue $LogWorkspaceId -LocalValues $localValues
$ContainerAppNames                 = Resolve-Setting -Name "CONTAINER_APP_NAMES" -ParamName "ContainerAppNames" -ParamValue $ContainerAppNames -LocalValues $localValues
$AppLogCollection                  = Resolve-Setting -Name "MONGO_COLLECTION_APP_LOG" -ParamName "AppLogCollection" -ParamValue $AppLogCollection -LocalValues $localValues
$AppLogCheckpointContainer         = Resolve-Setting -Name "APP_LOG_CHECKPOINT_CONTAINER" -ParamName "AppLogCheckpointContainer" -ParamValue $AppLogCheckpointContainer -LocalValues $localValues
$AppLogCheckpointBlob              = Resolve-Setting -Name "APP_LOG_CHECKPOINT_BLOB" -ParamName "AppLogCheckpointBlob" -ParamValue $AppLogCheckpointBlob -LocalValues $localValues

if (-not $MongoUri -or $MongoUri -match '^mongodb\+srv://USER') {
    Write-Host "ERROR: -MongoUri is required (missing or still the placeholder value)." -ForegroundColor Red
    Write-Host "Use -UseLocalSettings with a filled .env, or pass -MongoUri explicitly." -ForegroundColor Yellow
    exit 1
}

# Step 0: Verify tools and Azure login
Write-Host "Step 0: Verifying prerequisites..." -ForegroundColor Yellow

if (-not (Test-CommandExists "az")) {
    Write-Host "ERROR: 'az' is not installed or not on PATH." -ForegroundColor Red
    exit 1
}

$currentSub = az account show --query "{Name:name, ID:id, State:state}" -o json 2>$null | ConvertFrom-Json
if (-not $currentSub) {
    Write-Host "ERROR: Not logged in to Azure. Run 'az login' first." -ForegroundColor Red
    exit 1
}

Write-Host "Current subscription:" -ForegroundColor White
Write-Host "  Name:  $($currentSub.Name)" -ForegroundColor White
Write-Host "  ID:    $($currentSub.ID)" -ForegroundColor White
Write-Host "  State: $($currentSub.State)" -ForegroundColor White
Write-Host ""

if ($currentSub.State -ne "Enabled") {
    Write-Host "ERROR: Current subscription is not enabled." -ForegroundColor Red
    exit 1
}

# Resolve agent endpoint and key if omitted
if (-not $FunctionAppUrl) {
    Write-Host "Resolving FUNCTION_APP_URL from $FunctionAppName..." -ForegroundColor Yellow
    $functionHost = az functionapp show `
        --name $FunctionAppName `
        --resource-group $ResourceGroup `
        --query "defaultHostName" -o tsv
    if (-not $functionHost) {
        Write-Host "ERROR: Could not resolve Function App host. Pass -FunctionAppUrl explicitly." -ForegroundColor Red
        exit 1
    }
    $FunctionAppUrl = "https://$functionHost/api/processIncident"
}

if (-not $FunctionAppKey) {
    Write-Host "Resolving FUNCTION_APP_KEY from $FunctionAppName..." -ForegroundColor Yellow
    $FunctionAppKey = az functionapp keys list `
        --name $FunctionAppName `
        --resource-group $ResourceGroup `
        --query "functionKeys.default" -o tsv
    if (-not $FunctionAppKey) {
        Write-Host "ERROR: Could not resolve function key. Pass -FunctionAppKey explicitly." -ForegroundColor Red
        exit 1
    }
}

if (-not $CheckpointStorageConnectionString) {
    Write-Host "Resolving CHECKPOINT_STORAGE_CONNECTION_STRING from $StorageAccountName..." -ForegroundColor Yellow
    $CheckpointStorageConnectionString = az storage account show-connection-string `
        --name $StorageAccountName `
        --resource-group $ResourceGroup `
        --query "connectionString" -o tsv
    if (-not $CheckpointStorageConnectionString) {
        Write-Host "ERROR: Could not resolve storage connection string. Pass -CheckpointStorageConnectionString explicitly." -ForegroundColor Red
        exit 1
    }
}

if (-not $LogWorkspaceId -or -not $ContainerAppNames) {
    Write-Host "ERROR: -LogWorkspaceId / -ContainerAppNames are required (application log poller)." -ForegroundColor Red
    exit 1
}
# DT_ENV_URL / DT_CLIENT_ID / DT_CLIENT_SECRET are no longer read by index.js - the Dynatrace
# poller is not started. Left as optional pass-throughs only for manual rollback/debugging.

if (-not $GithubWebhookSecret) {
    $GithubWebhookSecret = Get-ContainerAppEnvValue -Name "GITHUB_WEBHOOK_SECRET"
}

if (-not $GithubWebhookSecret) {
    $GithubWebhookSecret = [guid]::NewGuid().ToString("N")
    Write-Host "Generated GITHUB_WEBHOOK_SECRET (use when registering GitHub org webhook):" -ForegroundColor Yellow
    Write-Host "  $GithubWebhookSecret" -ForegroundColor White
    Write-Host ""
}

if (-not $GithubToken) {
    $GithubToken = Get-ContainerAppEnvValue -Name "GITHUB_TOKEN"
}

if (-not $GithubOrg) {
    $GithubOrg = Get-ContainerAppEnvValue -Name "GITHUB_ORG"
}

if (-not $GithubOrg) {
    $GithubOrg = "devtechlp"
}

if (-not $CopilotBillingMode) {
    $CopilotBillingMode = Get-ContainerAppEnvValue -Name "COPILOT_BILLING_MODE"
}
if (-not $CopilotBillingMode) {
    $CopilotBillingMode = "ai_credits"
}

if (-not $CopilotBillingUser) {
    $CopilotBillingUser = Get-ContainerAppEnvValue -Name "COPILOT_BILLING_USER"
}

if (-not $CopilotBillingAccount) {
    $CopilotBillingAccount = Get-ContainerAppEnvValue -Name "COPILOT_BILLING_ACCOUNT"
}
if (-not $CopilotBillingAccount) {
    $CopilotBillingAccount = "user"
}

if (-not $CopilotModel) {
    $CopilotModel = Get-ContainerAppEnvValue -Name "COPILOT_MODEL"
}
if (-not $CopilotModel) {
    $CopilotModel = "claude-sonnet-5"
}

if (-not $CopilotCreditUsdRate) {
    $CopilotCreditUsdRate = Get-ContainerAppEnvValue -Name "COPILOT_CREDIT_USD_RATE"
}
if (-not $CopilotCreditUsdRate) {
    $CopilotCreditUsdRate = "0.01"
}

if (-not $GithubToken) {
    Write-Host "WARNING: GITHUB_TOKEN not set." -ForegroundColor Yellow
    Write-Host "         Copilot PR commit lookup and 5-minute empty-PR recheck will be disabled." -ForegroundColor Yellow
    Write-Host '         Pass -GithubToken on deploy (same as -DtEnvUrl / -DtClientSecret).' -ForegroundColor Yellow
    Write-Host ""
}

if (-not $CopilotBillingUser) {
    Write-Host "WARNING: COPILOT_BILLING_USER not set." -ForegroundColor Yellow
    Write-Host "         Copilot AI credit billing will fall back to org-only (often empty)." -ForegroundColor Yellow
    Write-Host "         Pass -CopilotBillingUser on deploy (e.g. lavanyapamula-lp)." -ForegroundColor Yellow
    Write-Host ""
}

# Jira - required when remediation_routing uses destination: "jira"
if (-not $JiraBaseUrl)              { $JiraBaseUrl = Get-ContainerAppEnvValue -Name "JIRA_BASE_URL" }
if (-not $JiraEmail)                { $JiraEmail = Get-ContainerAppEnvValue -Name "JIRA_EMAIL" }
if (-not $JiraApiToken)             { $JiraApiToken = Get-ContainerAppEnvValue -Name "JIRA_API_TOKEN" }
if (-not $JiraProjectKey)           { $JiraProjectKey = Get-ContainerAppEnvValue -Name "JIRA_PROJECT_KEY" }
if (-not $JiraIncidentIssuetypeId)  { $JiraIncidentIssuetypeId = Get-ContainerAppEnvValue -Name "JIRA_INCIDENT_ISSUETYPE_ID" }
if (-not $JiraServiceNameFieldId)   { $JiraServiceNameFieldId = Get-ContainerAppEnvValue -Name "JIRA_SERVICE_NAME_FIELD_ID" }
if (-not $JiraServiceDeskId)        { $JiraServiceDeskId = Get-ContainerAppEnvValue -Name "JIRA_SERVICE_DESK_ID" }
if (-not $JiraRequestTypeId)        { $JiraRequestTypeId = Get-ContainerAppEnvValue -Name "JIRA_REQUEST_TYPE_ID" }

$jiraVars = @{
    JIRA_BASE_URL               = $JiraBaseUrl
    JIRA_EMAIL                  = $JiraEmail
    JIRA_API_TOKEN              = $JiraApiToken
    JIRA_PROJECT_KEY            = $JiraProjectKey
    JIRA_INCIDENT_ISSUETYPE_ID  = $JiraIncidentIssuetypeId
    JIRA_SERVICE_NAME_FIELD_ID  = $JiraServiceNameFieldId
    JIRA_SERVICE_DESK_ID        = $JiraServiceDeskId
    JIRA_REQUEST_TYPE_ID        = $JiraRequestTypeId
}
$jiraCoreKeys = @('JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_SERVICE_NAME_FIELD_ID')
$jiraPortalKeys = @('JIRA_SERVICE_DESK_ID', 'JIRA_REQUEST_TYPE_ID')
$jiraCoreConfigured = ($jiraCoreKeys | ForEach-Object { $jiraVars[$_] }) -notcontains ''
$jiraPortalConfigured = ($jiraPortalKeys | ForEach-Object { $jiraVars[$_] }) -notcontains ''
$jiraFullyConfigured = $jiraCoreConfigured -and $jiraPortalConfigured

if ($jiraCoreConfigured -and -not $jiraPortalConfigured) {
    Write-Host 'WARNING: JIRA_SERVICE_DESK_ID / JIRA_REQUEST_TYPE_ID not set.' -ForegroundColor Yellow
    Write-Host '         Dynatrace incidents will use REST issue create and will NOT appear in the JSM portal queue.' -ForegroundColor Yellow
    Write-Host '         Set -JiraServiceDeskId and -JiraRequestTypeId (FPI: desk=2, Report an Issue=86).' -ForegroundColor Yellow
    Write-Host ""
} elseif (-not $jiraFullyConfigured) {
    Write-Host 'NOTE: Jira env vars not set - OK unless remediation_routing uses destination: jira.' -ForegroundColor Yellow
    Write-Host '      Pass -JiraBaseUrl, -JiraEmail, -JiraApiToken, -JiraServiceNameFieldId,' -ForegroundColor Yellow
    Write-Host '      -JiraServiceDeskId, -JiraRequestTypeId when enabling Jira routing.' -ForegroundColor Yellow
    Write-Host ""
}

$envVars = @{
    MONGO_URI                              = $MongoUri
    MONGO_DB_NAME                          = $MongoDbName
    MONGO_COLLECTION                       = $MongoCollection
    FUNCTION_APP_URL                       = $FunctionAppUrl
    FUNCTION_APP_KEY                       = $FunctionAppKey
    CHECKPOINT_STORAGE_CONNECTION_STRING   = $CheckpointStorageConnectionString
    CHECKPOINT_CONTAINER                   = $CheckpointContainer
    CHECKPOINT_BLOB                        = $CheckpointBlob
    LOG_LEVEL                              = $LogLevel
    PORT                                   = [string]$TargetPort
    GITHUB_WEBHOOK_SECRET                  = $GithubWebhookSecret

    # Application log poller - replaces the Dynatrace poller (not started by index.js anymore)
    LOG_WORKSPACE_ID                       = $LogWorkspaceId
    CONTAINER_APP_NAMES                    = $ContainerAppNames
    MONGO_COLLECTION_APP_LOG               = $AppLogCollection
    APP_LOG_CHECKPOINT_CONTAINER           = $AppLogCheckpointContainer
    APP_LOG_CHECKPOINT_BLOB                = $AppLogCheckpointBlob
}

if ($GithubToken) {
    $envVars.GITHUB_TOKEN = $GithubToken
}

$envVars.GITHUB_ORG = $GithubOrg
$envVars.COPILOT_BILLING_MODE = $CopilotBillingMode
$envVars.COPILOT_MODEL = $CopilotModel
$envVars.COPILOT_CREDIT_USD_RATE = $CopilotCreditUsdRate

if ($CopilotBillingUser) {
    $envVars.COPILOT_BILLING_USER = $CopilotBillingUser
}

if ($CopilotBillingAccount) {
    $envVars.COPILOT_BILLING_ACCOUNT = $CopilotBillingAccount
}

if ($InternalApiKey) {
    $envVars.INTERNAL_API_KEY = $InternalApiKey
}

$envVars.ENABLE_DYNATRACE_POLLER = $EnableDynatracePoller
if ($DtEnvUrl)            { $envVars.DT_ENV_URL = $DtEnvUrl }
if ($DtClientId)          { $envVars.DT_CLIENT_ID = $DtClientId }
if ($DtClientSecret)      { $envVars.DT_CLIENT_SECRET = $DtClientSecret }
if ($DynatraceWebhookToken) { $envVars.DYNATRACE_WEBHOOK_TOKEN = $DynatraceWebhookToken }
if ($PollerServiceNames)  { $envVars.POLLER_SERVICE_NAMES = $PollerServiceNames }

if ($jiraFullyConfigured) {
    foreach ($key in ($jiraVars.Keys | Sort-Object)) {
        if ($jiraVars[$key]) {
            $envVars[$key] = $jiraVars[$key]
        }
    }
} elseif ($jiraCoreConfigured) {
    foreach ($key in ($jiraCoreKeys + @('JIRA_PROJECT_KEY', 'JIRA_INCIDENT_ISSUETYPE_ID'))) {
        if ($jiraVars[$key]) {
            $envVars[$key] = $jiraVars[$key]
        }
    }
}

$envArgs = Get-ContainerAppEnvArgs -Env $envVars

if (-not $SkipInfrastructure) {
    # Step 1: Resource group
    Write-Host "Step 1: Checking resource group..." -ForegroundColor Yellow
    $rgExists = az group exists --name $ResourceGroup
    if ($rgExists -eq "false") {
        Write-Host "Creating resource group: $ResourceGroup" -ForegroundColor Yellow
        az group create --name $ResourceGroup --location $Location | Out-Null
    } else {
        Write-Host "Resource group exists: $ResourceGroup" -ForegroundColor Green
    }
    Write-Host ""

    # Step 2: ACR
    Write-Host "Step 2: Checking Azure Container Registry..." -ForegroundColor Yellow
    $acrExists = Test-AzResourceExists {
        az acr show --name $AcrName --resource-group $ResourceGroup
    }
    if (-not $acrExists) {
        Write-Host "ERROR: ACR '$AcrName' not found in $ResourceGroup." -ForegroundColor Red
        Write-Host "Create it first or pass -AcrName with an existing registry." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "ACR exists: $AcrName" -ForegroundColor Green
    Write-Host ""

    # Step 3: Container Apps environment
    Write-Host "Step 3: Checking Container Apps environment..." -ForegroundColor Yellow
    $caeExists = Test-AzResourceExists {
        az containerapp env show --name $ContainerAppsEnvironment --resource-group $ResourceGroup
    }
    if (-not $caeExists) {
        Write-Host "ERROR: Container Apps environment '$ContainerAppsEnvironment' not found in $ResourceGroup." -ForegroundColor Red
        Write-Host "Create it first or pass -ContainerAppsEnvironment with an existing environment." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Container Apps environment exists: $ContainerAppsEnvironment" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "Step 1-3: Skipping infrastructure checks (-SkipInfrastructure)" -ForegroundColor Yellow
    Write-Host ""
}

$AcrServer = "$AcrName.azurecr.io"
$Image = "${ContainerAppName}:${ImageTag}"
$FullImage = "$AcrServer/$Image"

# Step 4: Build and push image
if (-not $SkipBuild) {
    Write-Host "Step 4: Building and pushing Docker image to ACR..." -ForegroundColor Yellow
    Write-Host "  Registry: $AcrName" -ForegroundColor Gray
    Write-Host "  Image:    $Image" -ForegroundColor Gray
    az acr build `
        --registry $AcrName `
        --image $Image `
        .
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: ACR build failed" -ForegroundColor Red
        exit 1
    }
    Write-Host ""
} else {
    Write-Host "Step 4: Skipping image build (-SkipBuild)" -ForegroundColor Yellow
    Write-Host ""
}

# Step 5: ACR credentials
Write-Host "Step 5: Fetching ACR credentials..." -ForegroundColor Yellow
$AcrUsername = az acr credential show --name $AcrName --query "username" -o tsv
$AcrPassword = az acr credential show --name $AcrName --query "passwords[0].value" -o tsv
if (-not $AcrUsername -or -not $AcrPassword) {
    Write-Host "ERROR: Could not read ACR admin credentials. Enable admin on ACR or use managed identity." -ForegroundColor Red
    exit 1
}
Write-Host ""

# Step 6: Create or update Container App
Write-Host "Step 6: Deploying Container App..." -ForegroundColor Yellow
$appExists = Test-AzResourceExists {
    az containerapp show --name $ContainerAppName --resource-group $ResourceGroup
}

if (-not $appExists) {
    Write-Host "Creating Container App: $ContainerAppName" -ForegroundColor Yellow
    az containerapp create `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --environment $ContainerAppsEnvironment `
        --image $FullImage `
        --min-replicas 1 `
        --max-replicas 1 `
        --ingress external `
        --target-port $TargetPort `
        --registry-server $AcrServer `
        --registry-username $AcrUsername `
        --registry-password $AcrPassword `
        --env-vars @envArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Container App creation failed" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Updating Container App: $ContainerAppName" -ForegroundColor Yellow
    az containerapp update `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --image $FullImage `
        --min-replicas 1 `
        --max-replicas 1 `
        --set-env-vars @envArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Container App update failed" -ForegroundColor Red
        exit 1
    }

    az containerapp ingress enable `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --type external `
        --target-port $TargetPort | Out-Null

    az containerapp registry set `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --server $AcrServer `
        --username $AcrUsername `
        --password $AcrPassword | Out-Null
}

Write-Host "Container App deployed" -ForegroundColor Green
Write-Host ""

# Step 6b: Ensure managed identity + Log Analytics read access
# The application log poller authenticates with DefaultAzureCredential, which resolves to
# this identity when running in Azure (there is no `az login` inside the container).
Write-Host "Step 6b: Ensuring managed identity + Log Analytics access..." -ForegroundColor Yellow

$principalId = az containerapp identity show `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --query "principalId" -o tsv 2>$null

if (-not $principalId) {
    Write-Host "Assigning system-assigned managed identity..." -ForegroundColor Yellow
    $principalId = az containerapp identity assign `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --system-assigned `
        --query "principalId" -o tsv
}

if (-not $principalId) {
    Write-Host "WARNING: Could not resolve/assign managed identity - application log poller will fail to authenticate to Log Analytics." -ForegroundColor Yellow
} else {
    $workspaceIdQuery = "[?customerId=='$LogWorkspaceId'].id"
    $workspaceResourceIds = az monitor log-analytics workspace list --query $workspaceIdQuery -o tsv 2>$null
    $workspaceResourceId = $null
    if ($workspaceResourceIds) {
        $workspaceResourceId = @($workspaceResourceIds)[0]
    }

    if (-not $workspaceResourceId) {
        Write-Host "WARNING: Could not resolve Log Analytics workspace resource ID for customerId $LogWorkspaceId - skipping role assignment." -ForegroundColor Yellow
    } else {
        $roleQuery = "[?roleDefinitionName=='Log Analytics Reader'] | length(@)"
        $hasRole = az role assignment list --assignee $principalId --scope $workspaceResourceId --query $roleQuery -o tsv 2>$null

        if ($hasRole -eq "0" -or -not $hasRole) {
            Write-Host "Granting Log Analytics Reader on workspace..." -ForegroundColor Yellow
            az role assignment create `
                --assignee $principalId `
                --role "Log Analytics Reader" `
                --scope $workspaceResourceId | Out-Null
        } else {
            Write-Host "Log Analytics Reader already granted" -ForegroundColor Green
        }
    }
}
Write-Host ""

# Step 6c: Start app if it was stopped in Azure (Stop action sets runningStatus=Stopped)
$runningStatus = az containerapp show `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --query "properties.runningStatus" -o tsv 2>$null

if ($runningStatus -eq "Stopped") {
    Write-Host "Container App is stopped - starting it..." -ForegroundColor Yellow
    $appId = az containerapp show `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --query "id" -o tsv
    az resource invoke-action --action start --ids $appId | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Container App started" -ForegroundColor Green
    } else {
        Write-Host "WARNING: Could not start Container App automatically. Start it in Azure Portal." -ForegroundColor Yellow
    }
}

Write-Host ""

# Step 7: Summary
Write-Host "====================================================" -ForegroundColor Green
Write-Host "DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'

$fqdn = az containerapp show `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --query "properties.configuration.ingress.fqdn" -o tsv 2>$null

$ErrorActionPreference = $prevEap

if ($fqdn) {
    $healthUrl = "https://$fqdn/health"
    $dynatraceWebhookUrl = "https://$fqdn/api/dynatrace/webhook"
    $githubWebhookUrl = "https://$fqdn/api/github/webhook"
    Write-Host "Container App URL: https://$fqdn" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Health check:" -ForegroundColor Cyan
    Write-Host "  $healthUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "Dynatrace webhook (optional):" -ForegroundColor Cyan
    Write-Host "  $dynatraceWebhookUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "GitHub org webhook (Copilot status updates):" -ForegroundColor Cyan
    Write-Host "  $githubWebhookUrl" -ForegroundColor White
    Write-Host "  Secret: (GITHUB_WEBHOOK_SECRET - shown above if newly generated)" -ForegroundColor White
    Write-Host "  Events: Pull requests + Issue comments" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "Container App: $ContainerAppName (ingress FQDN not available yet)" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "Configured endpoints:" -ForegroundColor Cyan
Write-Host "  FUNCTION_APP_URL=$FunctionAppUrl" -ForegroundColor White
Write-Host "  MONGO_DB_NAME=$MongoDbName" -ForegroundColor White
Write-Host "  MONGO_COLLECTION=$MongoCollection" -ForegroundColor White
Write-Host "  CHECKPOINT_CONTAINER=$CheckpointContainer" -ForegroundColor White
Write-Host "  LOG_WORKSPACE_ID=$LogWorkspaceId" -ForegroundColor White
Write-Host "  CONTAINER_APP_NAMES=$ContainerAppNames" -ForegroundColor White
Write-Host "  MONGO_COLLECTION_APP_LOG=$AppLogCollection" -ForegroundColor White
if ($jiraFullyConfigured) {
    Write-Host "  JIRA_BASE_URL=$JiraBaseUrl" -ForegroundColor White
    Write-Host "  JIRA_REQUEST_TYPE_ID=$JiraRequestTypeId (portal customer request)" -ForegroundColor White
    Write-Host '  Jira routing: configured with JSM request type' -ForegroundColor White
} elseif ($jiraCoreConfigured) {
    Write-Host '  Jira routing: partial (missing desk/request type - portal queue disabled)' -ForegroundColor White
} else {
    Write-Host '  Jira routing: not configured (pass -Jira* params to enable)' -ForegroundColor White
}
Write-Host ""

Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Verify health:" -ForegroundColor White
if ($fqdn) {
    Write-Host "   Invoke-RestMethod -Uri '$healthUrl'" -ForegroundColor Gray
}
Write-Host "2. Stream logs:" -ForegroundColor White
Write-Host "   az containerapp logs show --name $ContainerAppName --resource-group $ResourceGroup --follow" -ForegroundColor Gray
Write-Host "3. Confirm change stream + application log poller started in logs" -ForegroundColor White
Write-Host ""
