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
