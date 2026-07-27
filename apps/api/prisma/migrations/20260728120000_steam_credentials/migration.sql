-- Steam credentials held by the panel rather than only in .env.
--
-- Arma 3's dedicated server package is not free, so SteamCMD needs an account
-- that owns the game. Keeping it in the environment meant editing .env and
-- restarting the whole stack to change it, and gave the panel no way to tell an
-- operator that the Steam login was what failed.
--
-- The password is AES-256-GCM encrypted with the same envelope as every other
-- stored credential. It is reversible by necessity - SteamCMD is handed the
-- real password - so it can never be a one-way hash the way an account
-- password is.

ALTER TABLE "platform_settings" ADD COLUMN "steamUsername" TEXT;
ALTER TABLE "platform_settings" ADD COLUMN "steamPasswordEnc" BYTEA;
ALTER TABLE "platform_settings" ADD COLUMN "steamCredentialsSetAt" TIMESTAMP(3);
