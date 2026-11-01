-- Better Auth 1.7.0 through 1.7.2 required account.issuer, with a unique index
-- on (issuer, accountId). 1.7.3 restored the 1.6 account schema and never
-- writes issuer, so the NOT NULL column would refuse every new account row.
-- SQLite has no ALTER COLUMN: drop the index, then the column, as Better
-- Auth's 1.7 upgrade guide prescribes for SQLite.
DROP INDEX IF EXISTS "account_issuer_accountId_uidx";

ALTER TABLE "account" DROP COLUMN "issuer";
