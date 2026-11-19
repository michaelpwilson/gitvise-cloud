-- Vectorize can delete only by id, but the apps/api vector port deletes by filter (namespace, kind, payload). This table
-- records every vector the gateway has written, with its payload, so a filter resolves to ids before deleteByIds runs.
--
-- Written before the Vectorize upsert, so a failed upsert can leave a stale row, which is harmless. The reverse would
-- leave a vector that no filter can find. Vector ids are unique per Vectorize index, so the id is the key.
CREATE TABLE vector_index (
  id         TEXT PRIMARY KEY,
  namespace  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload))
);

-- Every filtered delete starts with a namespace, and most also name a kind.
CREATE INDEX vector_index_by_namespace_kind ON vector_index (namespace, kind);
