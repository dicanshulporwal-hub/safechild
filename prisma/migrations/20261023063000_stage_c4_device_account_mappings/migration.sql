-- AlterTable: Device add activeChildId, mappedAccountSid
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "activeChildId" TEXT;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "mappedAccountSid" TEXT;

-- CreateTable: DeviceAccountMapping
CREATE TABLE IF NOT EXISTS "DeviceAccountMapping" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "windowsSid" TEXT NOT NULL,
    "windowsUsername" TEXT NOT NULL,
    "childId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAccountMapping_pkey" PRIMARY KEY ("id")
);

-- Indices for DeviceAccountMapping
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceAccountMapping_deviceId_windowsSid_key" ON "DeviceAccountMapping"("deviceId", "windowsSid");
CREATE INDEX IF NOT EXISTS "DeviceAccountMapping_familyId_idx" ON "DeviceAccountMapping"("familyId");
CREATE INDEX IF NOT EXISTS "DeviceAccountMapping_childId_idx" ON "DeviceAccountMapping"("childId");

-- Foreign Keys for DeviceAccountMapping
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeviceAccountMapping_deviceId_fkey'
  ) THEN
    ALTER TABLE "DeviceAccountMapping" ADD CONSTRAINT "DeviceAccountMapping_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeviceAccountMapping_familyId_fkey'
  ) THEN
    ALTER TABLE "DeviceAccountMapping" ADD CONSTRAINT "DeviceAccountMapping_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeviceAccountMapping_childId_fkey'
  ) THEN
    ALTER TABLE "DeviceAccountMapping" ADD CONSTRAINT "DeviceAccountMapping_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
