-- One copy of a file, however many notes point at it.
--
-- An attachment row carried its own bytes, so the same PDF on three notes was
-- three copies of that PDF in the database — and copying an attachment, which
-- the move/copy menu had just made a one-click operation, doubled a file every
-- time somebody used it.
--
-- The bytes move into `attachment_blobs`, keyed by their own SHA-256, and an
-- attachment becomes a name and a pointer. Two notes holding the same file now
-- hold two rows of metadata and share one blob.
--
-- **Keyed per owner, not globally.** Deduplicating across accounts would mean
-- one person's upload silently satisfying another's, and the existence of a
-- blob becoming a fact one account could learn about another. Hermes is
-- multi-user; the saving is not worth that.

CREATE TABLE IF NOT EXISTS attachment_blobs (
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256     text NOT NULL,
  size       integer NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, sha256)
);

-- Every distinct file that exists today, once each.
--
-- `DISTINCT ON` needs the digest to be a column it can order by, so it is
-- computed in the select rather than in the ON clause. Postgres has had
-- `sha256(bytea)` since 11.
INSERT INTO attachment_blobs (owner_id, sha256, size, data)
SELECT DISTINCT ON (owner_id, digest) owner_id, digest, size, data
FROM (
  SELECT owner_id, encode(sha256(data), 'hex') AS digest, size, data
  FROM attachments
) AS hashed
ORDER BY owner_id, digest
ON CONFLICT DO NOTHING;

-- Each attachment learns which blob is its own.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS sha256 text;
UPDATE attachments SET sha256 = encode(sha256(data), 'hex') WHERE sha256 IS NULL;

-- Nothing may be left pointing at nothing. Checked rather than assumed,
-- because the next statement drops the only other copy of these bytes and a
-- migration that runs in a transaction can still be wrong before it commits.
DO $$
DECLARE orphans integer;
BEGIN
  SELECT count(*) INTO orphans
  FROM attachments a
  LEFT JOIN attachment_blobs b ON b.owner_id = a.owner_id AND b.sha256 = a.sha256
  WHERE b.sha256 IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'attachment_blobs is missing % of the files attachments refer to', orphans;
  END IF;
END $$;

ALTER TABLE attachments ALTER COLUMN sha256 SET NOT NULL;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_blob_fk
  FOREIGN KEY (owner_id, sha256) REFERENCES attachment_blobs (owner_id, sha256);

-- The bytes are in one place now. Safe because the check above proved every
-- row has a blob, and because this whole file runs inside one transaction.
ALTER TABLE attachments DROP COLUMN data;

CREATE INDEX IF NOT EXISTS attachments_sha256 ON attachments (owner_id, sha256);
