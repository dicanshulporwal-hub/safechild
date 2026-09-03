-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SYSTEM_ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "FamilyRole" AS ENUM ('OWNER', 'PARENT', 'VIEWER');

-- CreateEnum
CREATE TYPE "FamilyApprovalRule" AS ENUM ('OWNER_ONLY', 'OWNER_OR_PARENT');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ALLOWED', 'DENIED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DeviceHealthState" AS ENUM ('PROTECTED', 'DEGRADED', 'OFFLINE');

-- Drop index that depends on old text column before altering type
DROP INDEX IF EXISTS "family_members_single_owner_idx";

-- AlterTable User
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "pendingMfaSecret" TEXT,
  ADD COLUMN IF NOT EXISTS "mobileNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "profilePhoto" TEXT,
  ADD COLUMN IF NOT EXISTS "timezone" TEXT,
  ADD COLUMN IF NOT EXISTS "language" TEXT;

-- AlterTable AccessRequest
ALTER TABLE "AccessRequest" 
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "RequestStatus" USING ("status"::"RequestStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable Policy
ALTER TABLE "Policy"
  ADD COLUMN IF NOT EXISTS "rules" JSONB,
  ADD COLUMN IF NOT EXISTS "isPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "studyMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable Device
ALTER TABLE "Device" 
  ADD COLUMN IF NOT EXISTS "deviceToken" TEXT,
  ALTER COLUMN "healthState" DROP DEFAULT,
  ALTER COLUMN "healthState" TYPE "DeviceHealthState" USING ("healthState"::"DeviceHealthState"),
  ALTER COLUMN "healthState" SET DEFAULT 'PROTECTED';

-- AlterTable Family
ALTER TABLE "Family" 
  ALTER COLUMN "approvalRule" DROP DEFAULT,
  ALTER COLUMN "approvalRule" TYPE "FamilyApprovalRule" USING ("approvalRule"::"FamilyApprovalRule"),
  ALTER COLUMN "approvalRule" SET DEFAULT 'OWNER_OR_PARENT';

-- AlterTable FamilyInvitation
ALTER TABLE "FamilyInvitation" 
  ALTER COLUMN "role" TYPE "FamilyRole" USING ("role"::"FamilyRole"),
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "InvitationStatus" USING ("status"::"InvitationStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable FamilyMember
ALTER TABLE "FamilyMember" 
  ALTER COLUMN "role" TYPE "FamilyRole" USING ("role"::"FamilyRole");

-- AlterTable User
ALTER TABLE "User" 
  ALTER COLUMN "systemRole" DROP DEFAULT,
  ALTER COLUMN "systemRole" TYPE "SystemRole" USING ("systemRole"::"SystemRole"),
  ALTER COLUMN "systemRole" SET DEFAULT 'USER';

-- Create Index and Composite Unique on Device
CREATE UNIQUE INDEX "Device_familyId_id_key" ON "Device"("familyId", "id");

-- Create Index for composite foreign keys
CREATE INDEX "AccessRequest_familyId_deviceId_idx" ON "AccessRequest"("familyId", "deviceId");
CREATE INDEX "ActivityEvent_familyId_deviceId_idx" ON "ActivityEvent"("familyId", "deviceId");
CREATE INDEX "ChildUsageRecord_familyId_deviceId_idx" ON "ChildUsageRecord"("familyId", "deviceId");

-- Add Composite Foreign Keys
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChildUsageRecord" ADD CONSTRAINT "ChildUsageRecord_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_familyId_deviceId_fkey" FOREIGN KEY ("familyId", "deviceId") REFERENCES "Device"("familyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recreate partial unique index for single owner on FamilyMember
CREATE UNIQUE INDEX "family_members_single_owner_idx" ON "FamilyMember"("familyId") WHERE "role" = 'OWNER'::"FamilyRole";

-- Deferrable trigger enforcing that every Family has exactly one OWNER member matching Family.ownerUserId
CREATE OR REPLACE FUNCTION check_family_owner_invariant()
RETURNS TRIGGER AS $$
DECLARE
  owner_member RECORD;
  owner_count INT;
BEGIN
  SELECT COUNT(*) INTO owner_count 
  FROM "FamilyMember" 
  WHERE "familyId" = NEW."id" AND "role" = 'OWNER'::"FamilyRole";

  IF owner_count != 1 THEN
    RAISE EXCEPTION 'Family % must have exactly one active OWNER (found %)', NEW."id", owner_count;
  END IF;

  SELECT "userId" INTO owner_member
  FROM "FamilyMember"
  WHERE "familyId" = NEW."id" AND "role" = 'OWNER'::"FamilyRole";

  IF NEW."ownerUserId" != owner_member."userId" THEN
    RAISE EXCEPTION 'Family.ownerUserId (%) does not match active OWNER member (%)', NEW."ownerUserId", owner_member."userId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS family_owner_check_trigger ON "Family";
CREATE CONSTRAINT TRIGGER family_owner_check_trigger
AFTER INSERT OR UPDATE ON "Family"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_family_owner_invariant();
