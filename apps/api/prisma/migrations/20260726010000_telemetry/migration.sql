-- Telemetry columns for anonymous usage reporting.
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "telemetryInstanceId" TEXT;
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "telemetryLastSentAt" TIMESTAMP(3);
