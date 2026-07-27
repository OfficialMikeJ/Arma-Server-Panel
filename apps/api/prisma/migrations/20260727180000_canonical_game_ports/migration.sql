-- Put game servers back on the ports their titles actually use.
--
-- Nodes were created with a 20000-40000 range, so an Arma 3 server was handed
-- something like 20000/20001 instead of the 2302-2306 the game, its launchers
-- and every direct-connect dialog assume. Each title now has its own band
-- (Arma 3 from 2302 stepping 100, per Bohemia's guidance for multiple
-- instances; Reforger from its stock 2001), and the node range only has to be
-- wide enough not to exclude them.
--
-- Only rows still sitting on the old default are moved: a range an operator
-- deliberately narrowed is left exactly as they set it.

ALTER TABLE "nodes" ALTER COLUMN "portRangeStart" SET DEFAULT 2001;

UPDATE "nodes" SET "portRangeStart" = 2001 WHERE "portRangeStart" = 20000;
