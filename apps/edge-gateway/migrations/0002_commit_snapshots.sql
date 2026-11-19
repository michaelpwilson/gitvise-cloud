-- Maps a commit to the packfile blob that materialises its tree.
-- The sandbox adapter reads this table to find what to hydrate before a run.
CREATE TABLE IF NOT EXISTS commit_snapshots (
  repo_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL CHECK (length(commit_hash) IN (40, 64)),
  blob_sha256 TEXT NOT NULL CHECK (length(blob_sha256) = 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (repo_id, commit_hash)
);
