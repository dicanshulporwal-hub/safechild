-- AlterTable: Family add timezone
ALTER TABLE "Family" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- AlterTable: Device runtime telemetry fields
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "activePolicyVersion" INTEGER;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "enforcementActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "protectionStatus" TEXT DEFAULT 'ACTIVE';
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "mappedAccountName" TEXT;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "hasMultipleSessions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "capabilities" JSONB;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "activityTelemetryAvailable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "appUsageAvailable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "domainUsageAvailable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "categoryUsageAvailable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "safeDinnerTimeSupported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "safeBedtimeSupported" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: TimelineEvent
CREATE TABLE IF NOT EXISTS "TimelineEvent" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "childId" TEXT,
    "deviceId" TEXT,
    "eventType" TEXT NOT NULL,
    "decision" TEXT,
    "domain" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- Indices for TimelineEvent
CREATE INDEX IF NOT EXISTS "TimelineEvent_familyId_idx" ON "TimelineEvent"("familyId");
CREATE INDEX IF NOT EXISTS "TimelineEvent_childId_idx" ON "TimelineEvent"("childId");
CREATE INDEX IF NOT EXISTS "TimelineEvent_familyId_childId_idx" ON "TimelineEvent"("familyId", "childId");
CREATE INDEX IF NOT EXISTS "TimelineEvent_timestamp_idx" ON "TimelineEvent"("timestamp");

-- Foreign Keys for TimelineEvent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimelineEvent_familyId_fkey'
  ) THEN
    ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimelineEvent_familyId_childId_fkey'
  ) THEN
    ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_familyId_childId_fkey" FOREIGN KEY ("familyId", "childId") REFERENCES "Child"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AlterTable: ChildUsageRecord
ALTER TABLE "ChildUsageRecord" ADD COLUMN IF NOT EXISTS "targetType" TEXT NOT NULL DEFAULT 'DOMAIN';
ALTER TABLE "ChildUsageRecord" ADD COLUMN IF NOT EXISTS "lastSyncId" TEXT;

-- Drop old unique index and create new unique index on ChildUsageRecord
DROP INDEX IF EXISTS "ChildUsageRecord_childId_target_date_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ChildUsageRecord_childId_targetType_target_date_key" ON "ChildUsageRecord"("childId", "targetType", "target", "date");

-- AlterTable: ActivityEvent
ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "clientEventId" TEXT;
CREATE INDEX IF NOT EXISTS "ActivityEvent_childId_clientEventId_idx" ON "ActivityEvent"("childId", "clientEventId");
