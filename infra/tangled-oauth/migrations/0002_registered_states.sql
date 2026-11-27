-- Callbacks now belong to a state a server filed first, and only its poll token collects them.
-- Rows live minutes, so the old ones are dropped rather than carried over.
DROP TABLE callbacks;
CREATE TABLE callbacks (
  state TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  query TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX callbacks_expires_at ON callbacks (expires_at);
