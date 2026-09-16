-- AlterEnum: Add PENDING_ACTIVATION to UserStatus enum
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING_ACTIVATION';

-- CreateEnum: ActivationTokenSource
CREATE TYPE "ActivationTokenSource" AS ENUM ('SELF_REGISTRATION', 'ADMIN_CREATED', 'ADMIN_REGENERATED');

-- AlterTable: Add activatedAt to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);

-- CreateTable: AccountActivationToken
CREATE TABLE IF NOT EXISTS "AccountActivationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "source" "ActivationTokenSource" NOT NULL DEFAULT 'SELF_REGISTRATION',
    "createdByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AccountActivationToken_tokenHash_key" ON "AccountActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccountActivationToken_userId_idx" ON "AccountActivationToken"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccountActivationToken_tokenHash_idx" ON "AccountActivationToken"("tokenHash");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AccountActivationToken_userId_fkey'
  ) THEN
    ALTER TABLE "AccountActivationToken" ADD CONSTRAINT "AccountActivationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Defense in depth: block session creation for PENDING_ACTIVATION and DISABLED accounts at PostgreSQL level
CREATE OR REPLACE FUNCTION "prevent_disabled_user_session"()
RETURNS TRIGGER AS $$
DECLARE
  v_status "UserStatus";
BEGIN
  SELECT "status" INTO v_status
  FROM "User"
  WHERE "id" = NEW."userId";

  IF v_status = 'DISABLED' THEN
    RAISE EXCEPTION 'ACCOUNT_DISABLED';
  ELSIF v_status = 'PENDING_ACTIVATION' THEN
    RAISE EXCEPTION 'ACCOUNT_ACTIVATION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
