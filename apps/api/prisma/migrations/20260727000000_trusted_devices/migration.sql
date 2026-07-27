-- Trusted devices: browsers allowed to skip the authenticator for a bounded time.
CREATE TABLE IF NOT EXISTS "trusted_devices" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgentHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_tokenHash_key" ON "trusted_devices"("tokenHash");
CREATE INDEX IF NOT EXISTS "trusted_devices_accountId_idx" ON "trusted_devices"("accountId");
CREATE INDEX IF NOT EXISTS "trusted_devices_expiresAt_idx" ON "trusted_devices"("expiresAt");

ALTER TABLE "trusted_devices"
  ADD CONSTRAINT "trusted_devices_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;