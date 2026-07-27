-- Games described as data rather than compiled in.
--
-- Adding a title meant editing the panel: a Dockerfile, an entrypoint, an entry
-- in the GAMES table and a rebuild. A definition carries the same information
-- as a document an administrator can upload.
--
-- Deliberately declarative. The format this borrows from carries a bash install
-- script and runs it in a container, which is remote code execution wearing a
-- config file - an uploaded one would run anything the uploader liked on the
-- host. Here the install is described and the panel's own entrypoint performs
-- it, so there is no field a shell command can be put in.

CREATE TABLE "game_definitions" (
    "slug"         TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "version"      TEXT NOT NULL DEFAULT '1',
    "definition"   JSONB NOT NULL,
    "builtIn"      BOOLEAN NOT NULL DEFAULT false,
    "enabled"      BOOLEAN NOT NULL DEFAULT true,
    "uploadedById" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_definitions_pkey" PRIMARY KEY ("slug")
);

ALTER TABLE "game_definitions"
  ADD CONSTRAINT "game_definitions_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
