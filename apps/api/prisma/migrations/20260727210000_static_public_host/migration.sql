-- Static public addresses.
--
-- A node whose address the operator stated - a static IP, or a DNS name they
-- control - does not need rediscovering, and a port they forwarded once by hand
-- stays forwarded. The panel previously reported every such setup as "automatic
-- port opening did not succeed" on each attempt, which is a permanent red cross
-- against something that is working correctly.
--
-- Existing rows are marked static when their publicHost is not an address the
-- panel could have discovered from a private interface: anything already
-- recorded came either from the operator or from a NAT-PMP/UPnP query, and both
-- are better treated as fixed than as needing rediscovery on every attempt.

ALTER TABLE "nodes" ADD COLUMN "staticPublicHost" BOOLEAN NOT NULL DEFAULT false;

UPDATE "nodes" SET "staticPublicHost" = true WHERE "publicHost" <> '';
