-- Pair a device that has no keyboard worth typing a token on.
--
-- The device starts a pairing and shows six digits; a signed-in person types
-- those into Hermes; the device, which has been polling, collects the key once
-- and the row is spent.
--
-- The code is deliberately not the secret. Six digits read off a screen cannot
-- be one, and treating them as such would leave a guessable path to a key. The
-- secret is the row id: minted server-side, returned only to the device that
-- asked, and required to collect. The code only says *which* pending device a
-- person means, and is only ever accepted from an authenticated session.
CREATE TABLE IF NOT EXISTS device_pairings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL,
  code          text NOT NULL,
  owner_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  token         text,
  token_id      uuid REFERENCES api_tokens(id) ON DELETE CASCADE,
  claimed_at    timestamptz,
  collected_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One live code at a time. A second pairing offering a code somebody is already
-- being asked to type is how a person approves the wrong device, so uniqueness
-- is enforced here rather than hoped for in the route — and only over the rows
-- that are still waiting, so a spent code can be handed out again later.
CREATE UNIQUE INDEX IF NOT EXISTS device_pairings_live_code
  ON device_pairings (code)
  WHERE claimed_at IS NULL;

-- Polled by the device every couple of seconds until it is claimed.
CREATE INDEX IF NOT EXISTS device_pairings_expiry ON device_pairings (expires_at);
