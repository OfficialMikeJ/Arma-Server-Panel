-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_TOTP', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ChallengeKind" AS ENUM ('TOTP_ENROLLMENT', 'LOGIN_TOTP', 'DISCORD_LINK', 'ADMIN_STEP_UP', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "UsernameAttemptOutcome" AS ENUM ('ACCEPTED', 'REJECTED_POLICY', 'REJECTED_ABUSIVE', 'REJECTED_TAKEN');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('PROVISIONING', 'ONLINE', 'DEGRADED', 'OFFLINE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "GameTitle" AS ENUM ('ARMA3', 'REFORGER', 'ARMA4');

-- CreateEnum
CREATE TYPE "ServerState" AS ENUM ('CREATING', 'INSTALLING', 'OFFLINE', 'STARTING', 'RUNNING', 'STOPPING', 'RESTARTING', 'REINSTALLING', 'CRASHED', 'SUSPENDED', 'DELETING');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "PortMethod" AS ENUM ('DIRECT', 'UPNP', 'NATPMP', 'PCP', 'RELAY', 'MANUAL');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('DISCORD_WEBHOOK', 'PUSHOVER', 'GENERIC_WEBHOOK');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'USER',
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING_TOTP',
    "username" TEXT NOT NULL,
    "canonicalUsername" TEXT NOT NULL,
    "passwordHash" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "totpSecretEnc" BYTEA,
    "totpEnrolledAt" TIMESTAMP(3),
    "totpLastStep" BIGINT,
    "totpVerified" BOOLEAN NOT NULL DEFAULT false,
    "discordId" TEXT,
    "discordUsername" TEXT,
    "discordAvatar" TEXT,
    "discordRefreshEnc" BYTEA,
    "isPlatformOwner" BOOLEAN NOT NULL DEFAULT false,
    "failedAuthCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAuthAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgentHash" TEXT NOT NULL,
    "elevated" BOOLEAN NOT NULL DEFAULT false,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" TEXT NOT NULL,
    "kind" "ChallengeKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "accountId" TEXT,
    "payloadEnc" BYTEA,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "username_attempts" (
    "id" TEXT NOT NULL,
    "clientHash" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "rawUsername" TEXT NOT NULL,
    "outcome" "UsernameAttemptOutcome" NOT NULL,
    "reason" TEXT,
    "warned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "username_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_bans" (
    "id" TEXT NOT NULL,
    "clientHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "trigger" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_counters" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "locationLabel" TEXT NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'PROVISIONING',
    "dockerEndpoint" TEXT NOT NULL,
    "dockerTlsEnc" BYTEA,
    "dataRoot" TEXT NOT NULL,
    "totalCpuThreads" INTEGER NOT NULL,
    "totalMemoryMib" INTEGER NOT NULL,
    "totalStorageGib" INTEGER NOT NULL,
    "downloadMbps" INTEGER NOT NULL,
    "uploadMbps" INTEGER NOT NULL,
    "cpuOvercommit" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "memoryOvercommit" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "publicHost" TEXT NOT NULL,
    "relayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "relayEndpoint" TEXT,
    "portRangeStart" INTEGER NOT NULL DEFAULT 20000,
    "portRangeEnd" INTEGER NOT NULL DEFAULT 40000,
    "requirementsPass" BOOLEAN NOT NULL DEFAULT false,
    "requirementsCheckedAt" TIMESTAMP(3),
    "lastSpeedTestAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "game" "GameTitle" NOT NULL,
    "state" "ServerState" NOT NULL DEFAULT 'CREATING',
    "ownerId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "containerId" TEXT,
    "containerName" TEXT NOT NULL,
    "volumePath" TEXT NOT NULL,
    "cpuCores" DOUBLE PRECISION NOT NULL,
    "cpuSet" TEXT,
    "memoryMib" INTEGER NOT NULL,
    "storageGib" INTEGER NOT NULL,
    "bandwidthMbps" INTEGER NOT NULL,
    "transferQuotaGib" INTEGER NOT NULL DEFAULT 0,
    "slots" INTEGER NOT NULL,
    "basePort" INTEGER NOT NULL,
    "publicHost" TEXT NOT NULL,
    "publicBasePort" INTEGER NOT NULL,
    "useRelay" BOOLEAN NOT NULL DEFAULT false,
    "autoPortForward" BOOLEAN NOT NULL DEFAULT true,
    "autoStart" BOOLEAN NOT NULL DEFAULT false,
    "autoRestart" BOOLEAN NOT NULL DEFAULT true,
    "crashRestartLimit" INTEGER NOT NULL DEFAULT 5,
    "crashCount" INTEGER NOT NULL DEFAULT 0,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendReason" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "startupParams" JSONB NOT NULL DEFAULT '{}',
    "secretsEnc" BYTEA,
    "installedVersion" TEXT,
    "lastInstallAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastStoppedAt" TIMESTAMP(3),
    "playersOnline" INTEGER NOT NULL DEFAULT 0,
    "lastQueryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_members" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_mods" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "modId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT,
    "installedVersion" TEXT,
    "installedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_mods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_presets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "game" "GameTitle" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "mods" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "port_allocations" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "serverId" TEXT,
    "portKey" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "internalPort" INTEGER NOT NULL,
    "externalPort" INTEGER NOT NULL,
    "method" "PortMethod" NOT NULL DEFAULT 'DIRECT',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "leaseExpiresAt" TIMESTAMP(3),
    "reachable" BOOLEAN,
    "lastVerifiedAt" TIMESTAMP(3),
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "port_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_samples" (
    "id" BIGSERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bucketSeconds" INTEGER,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryBytes" BIGINT NOT NULL,
    "memoryLimitBytes" BIGINT NOT NULL,
    "diskBytes" BIGINT NOT NULL,
    "netRxBytes" BIGINT NOT NULL,
    "netTxBytes" BIGINT NOT NULL,
    "playersOnline" INTEGER NOT NULL DEFAULT 0,
    "fps" DOUBLE PRECISION,

    CONSTRAINT "metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bandwidth_usage" (
    "id" BIGSERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "rxBytes" BIGINT NOT NULL DEFAULT 0,
    "txBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bandwidth_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "console_lines" (
    "id" BIGSERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stream" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "console_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_events" (
    "id" BIGSERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "server_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secretsEnc" BYTEA NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSentAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIpHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnc" BYTEA NOT NULL,
    "apiKeyHint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autonomousActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "proposedActions" JSONB NOT NULL DEFAULT '[]',
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "metadata" JSONB,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "setupComplete" BOOLEAN NOT NULL DEFAULT false,
    "bootstrapCredentialActive" BOOLEAN NOT NULL DEFAULT true,
    "registrationOpen" BOOLEAN NOT NULL DEFAULT true,
    "registrationRequiresInvite" BOOLEAN NOT NULL DEFAULT false,
    "requirementsReport" JSONB,
    "requirementsPass" BOOLEAN NOT NULL DEFAULT false,
    "requirementsCheckedAt" TIMESTAMP(3),
    "lastSpeedTestAt" TIMESTAMP(3),
    "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_username_key" ON "accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_canonicalUsername_key" ON "accounts"("canonicalUsername");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_discordId_key" ON "accounts"("discordId");

-- CreateIndex
CREATE INDEX "accounts_status_idx" ON "accounts"("status");

-- CreateIndex
CREATE INDEX "accounts_discordId_idx" ON "accounts"("discordId");

-- CreateIndex
CREATE INDEX "recovery_codes_accountId_idx" ON "recovery_codes"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_accountId_idx" ON "sessions"("accountId");

-- CreateIndex
CREATE INDEX "sessions_absoluteExpiresAt_idx" ON "sessions"("absoluteExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_tokenHash_key" ON "auth_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_challenges_expiresAt_idx" ON "auth_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "username_attempts_clientHash_normalized_idx" ON "username_attempts"("clientHash", "normalized");

-- CreateIndex
CREATE INDEX "username_attempts_createdAt_idx" ON "username_attempts"("createdAt");

-- CreateIndex
CREATE INDEX "registration_bans_clientHash_expiresAt_idx" ON "registration_bans"("clientHash", "expiresAt");

-- CreateIndex
CREATE INDEX "rate_counters_expiresAt_idx" ON "rate_counters"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_name_key" ON "nodes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "servers_containerId_key" ON "servers"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "servers_containerName_key" ON "servers"("containerName");

-- CreateIndex
CREATE INDEX "servers_ownerId_idx" ON "servers"("ownerId");

-- CreateIndex
CREATE INDEX "servers_nodeId_idx" ON "servers"("nodeId");

-- CreateIndex
CREATE INDEX "servers_state_idx" ON "servers"("state");

-- CreateIndex
CREATE INDEX "server_members_accountId_idx" ON "server_members"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "server_members_serverId_accountId_key" ON "server_members"("serverId", "accountId");

-- CreateIndex
CREATE INDEX "server_mods_serverId_order_idx" ON "server_mods"("serverId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "server_mods_serverId_modId_key" ON "server_mods"("serverId", "modId");

-- CreateIndex
CREATE INDEX "mod_presets_ownerId_game_idx" ON "mod_presets"("ownerId", "game");

-- CreateIndex
CREATE INDEX "port_allocations_serverId_idx" ON "port_allocations"("serverId");

-- CreateIndex
CREATE INDEX "port_allocations_leaseExpiresAt_idx" ON "port_allocations"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "port_allocations_nodeId_externalPort_protocol_key" ON "port_allocations"("nodeId", "externalPort", "protocol");

-- CreateIndex
CREATE INDEX "metric_samples_serverId_at_idx" ON "metric_samples"("serverId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "bandwidth_usage_serverId_periodStart_key" ON "bandwidth_usage"("serverId", "periodStart");

-- CreateIndex
CREATE INDEX "console_lines_serverId_seq_idx" ON "console_lines"("serverId", "seq");

-- CreateIndex
CREATE INDEX "console_lines_at_idx" ON "console_lines"("at");

-- CreateIndex
CREATE INDEX "server_events_serverId_at_idx" ON "server_events"("serverId", "at");

-- CreateIndex
CREATE INDEX "backups_serverId_idx" ON "backups"("serverId");

-- CreateIndex
CREATE INDEX "integrations_serverId_idx" ON "integrations"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_accountId_idx" ON "api_keys"("accountId");

-- CreateIndex
CREATE INDEX "ai_providers_accountId_idx" ON "ai_providers"("accountId");

-- CreateIndex
CREATE INDEX "ai_sessions_serverId_idx" ON "ai_sessions"("serverId");

-- CreateIndex
CREATE INDEX "notifications_accountId_readAt_idx" ON "notifications"("accountId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_hash_key" ON "audit_logs"("hash");

-- CreateIndex
CREATE INDEX "audit_logs_at_idx" ON "audit_logs"("at");

-- CreateIndex
CREATE INDEX "audit_logs_accountId_at_idx" ON "audit_logs"("accountId", "at");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_mods" ADD CONSTRAINT "server_mods_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "port_allocations" ADD CONSTRAINT "port_allocations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "port_allocations" ADD CONSTRAINT "port_allocations_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bandwidth_usage" ADD CONSTRAINT "bandwidth_usage_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "console_lines" ADD CONSTRAINT "console_lines_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_events" ADD CONSTRAINT "server_events_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

