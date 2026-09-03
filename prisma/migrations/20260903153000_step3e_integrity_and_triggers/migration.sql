-- Stage 11 Step 3E: Relational Tenancy & Owner Invariant Triggers Migration

-- 1. Drop old foreign keys if they exist
ALTER TABLE "AccessRequest" DROP CONSTRAINT IF EXISTS "AccessRequest_familyId_deviceId_fkey";
ALTER TABLE "ChildUsageRecord" DROP CONSTRAINT IF EXISTS "ChildUsageRecord_familyId_deviceId_fkey";
ALTER TABLE "ActivityEvent" DROP CONSTRAINT IF EXISTS "ActivityEvent_familyId_deviceId_fkey";

-- 2. Add composite foreign key constraints enforcing (familyId, childId, deviceId) -> Device(familyId, childId, id)
ALTER TABLE "AccessRequest" 
ADD CONSTRAINT "AccessRequest_familyId_childId_deviceId_fkey" 
FOREIGN KEY ("familyId", "childId", "deviceId") 
REFERENCES "Device"("familyId", "childId", "id") 
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChildUsageRecord" 
ADD CONSTRAINT "ChildUsageRecord_familyId_childId_deviceId_fkey" 
FOREIGN KEY ("familyId", "childId", "deviceId") 
REFERENCES "Device"("familyId", "childId", "id") 
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityEvent" 
ADD CONSTRAINT "ActivityEvent_familyId_childId_deviceId_fkey" 
FOREIGN KEY ("familyId", "childId", "deviceId") 
REFERENCES "Device"("familyId", "childId", "id") 
ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Create or replace the comprehensive deferred single-owner invariant check function
CREATE OR REPLACE FUNCTION check_family_single_owner_invariant()
RETURNS TRIGGER AS $$
DECLARE
  target_family_id TEXT;
  owner_count INTEGER;
  fam_owner_user_id TEXT;
  member_owner_user_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'FamilyMember' THEN
    IF TG_OP = 'DELETE' THEN
      target_family_id := OLD."familyId";
    ELSE
      target_family_id := NEW."familyId";
    END IF;
  ELSIF TG_TABLE_NAME = 'Family' THEN
    target_family_id := NEW."id";
  END IF;

  -- Fetch owner count and owner userId for the target family
  SELECT COUNT(*), MAX("userId") INTO owner_count, member_owner_user_id
  FROM "FamilyMember"
  WHERE "familyId" = target_family_id AND "role" = 'OWNER';

  -- Fetch ownerUserId from Family table
  SELECT "ownerUserId" INTO fam_owner_user_id
  FROM "Family"
  WHERE "id" = target_family_id;

  -- Enforce invariant if family exists
  IF fam_owner_user_id IS NOT NULL THEN
    IF owner_count != 1 THEN
      RAISE EXCEPTION 'Family % invariant violation: Must have exactly 1 OWNER member (found %)', target_family_id, owner_count;
    END IF;

    IF member_owner_user_id != fam_owner_user_id THEN
      RAISE EXCEPTION 'Family % invariant violation: Family.ownerUserId (%) does not match FamilyMember OWNER (%)', target_family_id, fam_owner_user_id, member_owner_user_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 4. Attach constraint trigger to FamilyMember
DROP TRIGGER IF EXISTS family_owner_check_trigger ON "FamilyMember";
DROP TRIGGER IF EXISTS family_member_owner_check_trigger ON "FamilyMember";
CREATE CONSTRAINT TRIGGER family_member_owner_check_trigger
AFTER INSERT OR UPDATE OR DELETE ON "FamilyMember"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_family_single_owner_invariant();

-- 5. Attach constraint trigger to Family on ownerUserId update
DROP TRIGGER IF EXISTS family_owner_user_id_check_trigger ON "Family";
CREATE CONSTRAINT TRIGGER family_owner_user_id_check_trigger
AFTER INSERT OR UPDATE OF "ownerUserId" ON "Family"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_family_single_owner_invariant();
