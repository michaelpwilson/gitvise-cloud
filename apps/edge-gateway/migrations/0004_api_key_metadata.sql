-- API key metadata for listing: a non-secret display prefix, and when the key last authenticated a request.
-- Keys minted before this migration have no stored prefix (listing shows the generic `gv_live_` start) and no last-use time.

-- The first characters of the key (`gv_live_` plus 8 random characters). Safe to show: it is not enough to authenticate.
ALTER TABLE api_keys ADD COLUMN prefix TEXT;

-- Unix seconds of the last request that authenticated with this key. Null until first use.
ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER;
