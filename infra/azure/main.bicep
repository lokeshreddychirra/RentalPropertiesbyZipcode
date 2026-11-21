// PropertyYield AI on Azure Container Apps.
//
// Creates: Log Analytics, a Container Apps environment, PostgreSQL Flexible Server
// (PostGIS enabled), Azure Cache for Redis, and four workloads built from two images:
//   web     Next.js UI                (public HTTPS ingress)
//   api     FastAPI                   (internal ingress only — reached through web)
//   worker  Redis-backed job worker   (no ingress)
//   migrate Alembic migration job     (run manually or from CI before each rollout)
//
// The application itself is provider-independent: the same two container images and
// environment variables run on any container platform (see docs/DEPLOYMENT.md).
//
// Deploy:
//   az deployment group create -g <resource-group> -f infra/azure/main.bicep -p infra/azure/main.parameters.json

@description('Short name used as a prefix for all resources (lowercase letters and digits).')
@minLength(3)
@maxLength(16)
param appName string = 'propertyyield'

param location string = resourceGroup().location

@description('Name of an existing Azure Container Registry in this resource group holding the images.')
param acrName string

@description('Image tags, e.g. the git SHA pushed by CI.')
param apiImageTag string = 'latest'
param webImageTag string = 'latest'

@description('PostgreSQL administrator login.')
param postgresAdminLogin string = 'pyadmin'

@secure()
@description('PostgreSQL administrator password. Use URL-safe characters (letters, digits, - and _).')
param postgresAdminPassword string

@secure()
@description('Random secret (32+ characters) used to sign session tokens.')
param secretKey string

@secure()
param rentcastApiKey string = ''

@secure()
param airdnaApiKey string = ''

@secure()
@description('Mapbox secret token for server-side geocoding.')
param mapboxAccessToken string = ''

@description('Mapbox public token (pk.…) for the browser map.')
param mapboxPublicToken string = ''

@secure()
param anthropicApiKey string = ''

@allowed(['auto', 'demo', 'live'])
param dataMode string = 'auto'

@description('Comma-separated administrator email addresses.')
param adminEmails string = ''

param llmModel string = 'claude-opus-5-5'
param rentcastMonthlyRequestBudget int = 1000

var tags = { application: 'propertyyield-ai' }
var suffix = uniqueString(resourceGroup().id, appName)
var postgresName = '${appName}-pg-${suffix}'
var redisName = '${appName}-redis-${suffix}'
var databaseName = 'propertyyield'

// --------------------------------------------------------------------------- observability

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// --------------------------------------------------------------------------- identity + registry

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-identity'
  location: location
  tags: tags
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// AcrPull
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, 'acrpull')
  scope: acr
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// --------------------------------------------------------------------------- data stores

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = {
  name: postgresName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B2s'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = {
  parent: postgres
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Allow-list PostGIS so the first migration can CREATE EXTENSION postgis.
resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2022-12-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: { value: 'POSTGIS', source: 'user-override' }
}

// Simplest secure-by-TLS setup: reachable from Azure services only. For production,
// prefer VNet integration / private endpoints for both PostgreSQL and Redis.
resource postgresFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2022-12-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource redis 'Microsoft.Cache/redis@2023-08-01' = {
  name: redisName
  location: location
  tags: tags
  properties: {
    sku: { name: 'Basic', family: 'C', capacity: 0 }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    redisConfiguration: { 'maxmemory-policy': 'allkeys-lru' }
  }
}

// --------------------------------------------------------------------------- shared configuration

var registry = [
  {
    server: acr.properties.loginServer
    identity: identity.id
  }
]

var backendSecrets = [
  { name: 'database-url', value: 'postgresql+asyncpg://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?ssl=require' }
  { name: 'redis-url', value: 'rediss://:${redis.listKeys().primaryKey}@${redis.properties.hostName}:6380/0' }
  { name: 'secret-key', value: secretKey }
  // Container Apps rejects empty secret values, so unset optional keys are stored as a single space
  // (the application treats blank values as "not configured").
  { name: 'rentcast-api-key', value: empty(rentcastApiKey) ? ' ' : rentcastApiKey }
  { name: 'airdna-api-key', value: empty(airdnaApiKey) ? ' ' : airdnaApiKey }
  { name: 'mapbox-access-token', value: empty(mapboxAccessToken) ? ' ' : mapboxAccessToken }
  { name: 'anthropic-api-key', value: empty(anthropicApiKey) ? ' ' : anthropicApiKey }
]

var backendEnv = [
  { name: 'ENVIRONMENT', value: 'production' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  { name: 'SECRET_KEY', secretRef: 'secret-key' }
  { name: 'SESSION_COOKIE_SECURE', value: 'true' }
  { name: 'DATA_MODE', value: dataMode }
  { name: 'ADMIN_EMAILS', value: adminEmails }
  { name: 'RENTCAST_API_KEY', secretRef: 'rentcast-api-key' }
  { name: 'RENTCAST_MONTHLY_REQUEST_BUDGET', value: string(rentcastMonthlyRequestBudget) }
  { name: 'AIRDNA_API_KEY', secretRef: 'airdna-api-key' }
  { name: 'MAPBOX_ACCESS_TOKEN', secretRef: 'mapbox-access-token' }
  { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
  { name: 'LLM_MODEL', value: llmModel }
  { name: 'PUBLIC_APP_URL', value: 'https://${appName}-web.${environment.properties.defaultDomain}' }
  { name: 'CORS_ORIGINS', value: 'https://${appName}-web.${environment.properties.defaultDomain}' }
]

var apiImage = '${acr.properties.loginServer}/propertyyield-api:${apiImageTag}'
var webImage = '${acr.properties.loginServer}/propertyyield-web:${webImageTag}'

// --------------------------------------------------------------------------- workloads

resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: '${appName}-migrate'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  dependsOn: [acrPull, postgresDatabase, postgresExtensions, postgresFirewall]
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: registry
      secrets: backendSecrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: apiImage
          args: ['migrate']
          env: backendEnv
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-api'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  dependsOn: [acrPull, postgresDatabase, postgresFirewall]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8000, transport: 'http' }
      registries: registry
      secrets: backendSecrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          args: ['api']
          env: concat(backendEnv, [{ name: 'WEB_CONCURRENCY', value: '2' }])
          resources: { cpu: json('1.0'), memory: '2Gi' }
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8000 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 8000 }, periodSeconds: 15 }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '40' } } }]
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-worker'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  dependsOn: [acrPull, postgresDatabase, postgresFirewall]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registry
      secrets: backendSecrets
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: apiImage
          args: ['worker']
          env: backendEnv
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
      // Keep one worker running so scheduled alert checks always fire.
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-web'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  dependsOn: [acrPull]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false }
      registries: registry
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          env: [
            { name: 'BACKEND_URL', value: 'http://${api.name}' }
            { name: 'MAPBOX_PUBLIC_TOKEN', value: mapboxPublicToken }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [{ type: 'Liveness', httpGet: { path: '/api/config', port: 3000 }, periodSeconds: 30 }]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '60' } } }]
      }
    }
  }
}

output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output migrateJobName string = migrate.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
