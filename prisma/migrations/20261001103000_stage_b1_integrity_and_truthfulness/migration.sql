-- AlterTable: Family default timezone to UTC
ALTER TABLE "Family" ALTER COLUMN "timezone" SET DEFAULT 'UTC';

-- AlterTable: TimelineEvent add category and policyVersion
ALTER TABLE "TimelineEvent" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "TimelineEvent" ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER;

-- AlterTable: ActivityEvent make clientEventId uniquely constrained per child
DROP INDEX IF EXISTS "ActivityEvent_childId_clientEventId_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "ActivityEvent_childId_clientEventId_key" ON "ActivityEvent"("childId", "clientEventId");

-- CreateTable: UsageSyncReceipt for durable transaction-level idempotency
CREATE TABLE IF NOT EXISTS "UsageSyncReceipt" (
    "id" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT 'DOMAIN',
    "target" TEXT NOT NULL,
    "usageDate" TEXT NOT NULL,
    "secondsIncrement" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageSyncReceipt_pkey" PRIMARY KEY ("id")
);

-- Indices for UsageSyncReceipt
CREATE UNIQUE INDEX IF NOT EXISTS "UsageSyncReceipt_deviceId_syncId_key" ON "UsageSyncReceipt"("deviceId", "syncId");
CREATE INDEX IF NOT EXISTS "UsageSyncReceipt_familyId_idx" ON "UsageSyncReceipt"("familyId");
CREATE INDEX IF NOT EXISTS "UsageSyncReceipt_childId_idx" ON "UsageSyncReceipt"("childId");
CREATE INDEX IF NOT EXISTS "UsageSyncReceipt_familyId_deviceId_idx" ON "UsageSyncReceipt"("familyId", "deviceId");

-- Foreign Keys for UsageSyncReceipt
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageSyncReceipt_familyId_fkey'
  ) THEN
    ALTER TABLE "UsageSyncReceipt" ADD CONSTRAINT "UsageSyncReceipt_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageSyncReceipt_familyId_childId_fkey'
  ) THEN
    ALTER TABLE "UsageSyncReceipt" ADD CONSTRAINT "UsageSyncReceipt_familyId_childId_fkey" FOREIGN KEY ("familyId", "childId") REFERENCES "Child"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageSyncReceipt_familyId_childId_deviceId_fkey'
  ) THEN
    ALTER TABLE "UsageSyncReceipt" ADD CONSTRAINT "UsageSyncReceipt_familyId_childId_deviceId_fkey" FOREIGN KEY ("familyId", "childId", "deviceId") REFERENCES "Device"("familyId", "childId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
