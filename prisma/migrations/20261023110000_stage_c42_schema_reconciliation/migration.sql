-- CreateTable: PushSubscription
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- Unique and Index for PushSubscription
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- Foreign Key for PushSubscription (User)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_userId_fkey'
  ) THEN
    ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Schema Composite Indexes
CREATE INDEX IF NOT EXISTS "AccessRequest_familyId_childId_deviceId_idx" ON "AccessRequest"("familyId", "childId", "deviceId");
CREATE INDEX IF NOT EXISTS "ActivityEvent_familyId_childId_deviceId_idx" ON "ActivityEvent"("familyId", "childId", "deviceId");
CREATE INDEX IF NOT EXISTS "ChildUsageRecord_familyId_childId_deviceId_idx" ON "ChildUsageRecord"("familyId", "childId", "deviceId");
CREATE INDEX IF NOT EXISTS "UsageSyncReceipt_deviceId_syncId_idx" ON "UsageSyncReceipt"("deviceId", "syncId");

-- Drop obsolete index created by Stage B.1
DROP INDEX IF EXISTS "UsageSyncReceipt_familyId_deviceId_idx";

-- Reconcile updatedAt default with Prisma @updatedAt model attribute
ALTER TABLE "DeviceAccountMapping" ALTER COLUMN "updatedAt" DROP DEFAULT;
