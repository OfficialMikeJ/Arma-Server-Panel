-- Sub-admins and access requests.
--
-- Two things the panel could not express before:
--
--   * An administrator who runs the panel but has no business inside anyone's
--     game server. ADMIN grants implicit admin on every server, which is the
--     wrong shape for someone who should only manage nodes or read the audit
--     trail. SUB_ADMIN is scoped by panelPermissions and is never given
--     implicit server access - a sub-admin who needs one is added as a member
--     like anybody else.
--
--   * Asking for more access. A sub-user who needs a permission they do not
--     hold had no way to say so, and no administrator had anywhere to see it.

ALTER TYPE "AccountType" ADD VALUE 'SUB_ADMIN';

ALTER TABLE "accounts" ADD COLUMN "panelPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'WITHDRAWN');

CREATE TABLE "access_requests" (
    "id"           TEXT NOT NULL,
    "accountId"    TEXT NOT NULL,
    "serverId"     TEXT,
    "requested"    TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason"       TEXT NOT NULL,
    "status"       "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById"  TEXT,
    "decidedAt"    TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_requests_accountId_idx" ON "access_requests"("accountId");
CREATE INDEX "access_requests_serverId_idx"  ON "access_requests"("serverId");
CREATE INDEX "access_requests_status_idx"    ON "access_requests"("status");

ALTER TABLE "access_requests"
  ADD CONSTRAINT "access_requests_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_requests"
  ADD CONSTRAINT "access_requests_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_requests"
  ADD CONSTRAINT "access_requests_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
