-- Rotation grace window.
--
-- Token rotation previously invalidated the old token the instant it happened.
-- The panel keeps several requests in flight at once (a five-second metrics
-- poll, a ten-second dashboard poll, a console socket), so requests already on
-- the wire carried a token that no longer existed and the operator was signed
-- out. These columns let the pre-rotation token keep working for a short,
-- bounded window.

ALTER TABLE "sessions" ADD COLUMN "previousTokenHash" TEXT;
ALTER TABLE "sessions" ADD COLUMN "previousCsrfTokenHash" TEXT;
ALTER TABLE "sessions" ADD COLUMN "previousTokenExpiresAt" TIMESTAMP(3);

CREATE INDEX "sessions_previousTokenHash_idx" ON "sessions"("previousTokenHash");
