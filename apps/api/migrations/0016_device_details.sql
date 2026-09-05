-- What a device IS, and how it got here.
--
-- The phone already tells the desktop its model and OS in the bridge's hello
-- frame, but that lived only in the desktop's memory: restart it, or open the
-- panel while the phone is asleep, and a paired phone became a bare name. The
-- org is the durable side of every other fact about a device, so it holds
-- these too — written at the claim and refreshed on every connect.
--
-- pair_method is the server's own record of which door was used (the typed
-- code or the scanned QR), never the client's claim about it.
ALTER TABLE devices ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN os TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN os_version TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN pair_method TEXT NOT NULL DEFAULT '';
