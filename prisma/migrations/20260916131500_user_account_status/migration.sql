-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "disabledAt" TIMESTAMP(3),
ADD COLUMN "disabledReason" TEXT,
ADD COLUMN "disabledByUserId" TEXT;

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_systemRole_status_idx" ON "User"("systemRole", "status");

-- Defense in depth: never allow a new web session for a disabled account.
CREATE OR REPLACE FUNCTION "prevent_disabled_user_session"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "id" = NEW."userId" AND "status" = 'DISABLED'
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DISABLED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UserSession_block_disabled_user"
BEFORE INSERT ON "UserSession"
FOR EACH ROW
EXECUTE FUNCTION "prevent_disabled_user_session"();
