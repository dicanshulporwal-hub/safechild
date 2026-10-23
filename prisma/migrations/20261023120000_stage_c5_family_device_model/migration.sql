-- Drop old compound foreign keys referencing Device(familyId, childId, id)
ALTER TABLE "AccessRequest" DROP CONSTRAINT IF EXISTS "AccessRequest_familyId_childId_deviceId_fkey";
ALTER TABLE "ActivityEvent" DROP CONSTRAINT IF EXISTS "ActivityEvent_familyId_childId_deviceId_fkey";
ALTER TABLE "ChildUsageRecord" DROP CONSTRAINT IF EXISTS "ChildUsageRecord_familyId_childId_deviceId_fkey";
ALTER TABLE "UsageSyncReceipt" DROP CONSTRAINT IF EXISTS "UsageSyncReceipt_familyId_childId_deviceId_fkey";

-- Drop old compound unique constraint on Device(familyId, childId, id)
DROP INDEX IF EXISTS "Device_familyId_childId_id_key";

-- AlterTable: Make Device.childId nullable for family-level Windows devices
ALTER TABLE "Device" ALTER COLUMN "childId" DROP NOT NULL;

-- AlterTable: Make PairingCode.childId nullable and add platformIntent
ALTER TABLE "PairingCode" ADD COLUMN IF NOT EXISTS "platformIntent" TEXT DEFAULT 'WINDOWS';
ALTER TABLE "PairingCode" ALTER COLUMN "childId" DROP NOT NULL;

-- Add updated foreign keys referencing Device(familyId, id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AccessRequest_familyId_deviceId_fkey'
  ) THEN
    ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ChildUsageRecord_familyId_deviceId_fkey'
  ) THEN
    ALTER TABLE "ChildUsageRecord" ADD CONSTRAINT "ChildUsageRecord_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ActivityEvent_familyId_deviceId_fkey'
  ) THEN
    ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageSyncReceipt_familyId_deviceId_fkey'
  ) THEN
    ALTER TABLE "UsageSyncReceipt" ADD CONSTRAINT "UsageSyncReceipt_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
