-- Whether a phone can actually be pushed, and what Expo last said about it.
--
-- Push health was knowable only inside one user's UserBridge, as a key in
-- Durable Object storage nothing else can read. So when notifications stopped
-- arriving there was no answer anywhere to "can this phone be pushed at all?"
-- — not for an admin looking at the device, not for the desktop panel, and
-- not for the model, which went on reporting sends as UNCONFIRMED without
-- ever being able to say why. Every one of those readers already reads the
-- device row, so the answer belongs on it.
--
-- push_state is what the ORG believes about this handset's token:
--   unknown  never registered — no app build of this device has ever asked
--   none     registered WITHOUT a token: notification permission was refused,
--            or it is a simulator, which cannot hold one. In-band only, and
--            legitimately so — this is not a fault to chase.
--   live     a token is registered and nothing has since said it is dead
--   dead     Expo answered DeviceNotRegistered: the app was uninstalled or
--            the token rotated. The registration is deleted when this is set,
--            so the state outlives the thing it describes on purpose.
--
-- push_error keeps the LAST failure verbatim (an Expo error code, or the
-- transport's own words) beside the moment it happened, because the codes that
-- matter most — InvalidCredentials above all — say nothing about this device
-- and everything about the org's Expo project.
--
-- push_delivered_at is the only honest "it worked": set from a delivery
-- RECEIPT, never from a send. A ticket means Expo took the message; a receipt
-- means APNs or FCM did.
ALTER TABLE devices ADD COLUMN push_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (push_state IN ('unknown', 'none', 'live', 'dead'));
ALTER TABLE devices ADD COLUMN push_registered_at TEXT;
ALTER TABLE devices ADD COLUMN push_sent_at TEXT;
ALTER TABLE devices ADD COLUMN push_delivered_at TEXT;
ALTER TABLE devices ADD COLUMN push_error TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN push_error_at TEXT;
