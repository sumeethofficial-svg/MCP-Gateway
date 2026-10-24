-- mcp-portal gateway schema.
-- Secrets are never stored in clear: passwords use scrypt, API keys and invite/session
-- tokens are stored as SHA-256 digests, upstream credentials are AES-256-GCM ciphertext.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text NOT NULL,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash    text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL UNIQUE,
  key_hash     text NOT NULL,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

CREATE TABLE upstream_servers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 24),
  name              text NOT NULL,
  url               text NOT NULL,
  auth_type         text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name  text,
  credential_enc    text,
  enabled           boolean NOT NULL DEFAULT true,
  -- When true the gateway believes the server's readOnlyHint annotations. Off by default:
  -- a malicious server can claim anything.
  trust_annotations boolean NOT NULL DEFAULT false,
  managed_by        text NOT NULL DEFAULT 'admin' CHECK (managed_by IN ('admin', 'helm')),
  -- Bumped on every change so each gateway replica can invalidate cached connections.
  version           integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'connected', 'unreachable')),
  status_reason     text,
  last_checked_at   timestamptz,
  last_latency_ms   integer,
  tool_count        integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Trust-on-first-use pinning of tool definitions. Only 'approved' tools are exposed.
CREATE TABLE tool_pins (
  server_id            uuid NOT NULL REFERENCES upstream_servers (id) ON DELETE CASCADE,
  tool_name            text NOT NULL,
  def_hash             text NOT NULL,
  status               text NOT NULL CHECK (status IN ('approved', 'quarantined', 'rejected')),
  reason               text,
  description          text,
  previous_description text,
  flags                text[] NOT NULL DEFAULT '{}',
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  changed_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at          timestamptz,
  PRIMARY KEY (server_id, tool_name)
);

CREATE TABLE tool_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('role', 'user')),
  subject      text NOT NULL,
  server_slug  text NOT NULL DEFAULT '*',
  tool_name    text NOT NULL DEFAULT '*',
  effect       text NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject, server_slug, tool_name)
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  request_id    text,
  user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  user_email    text,
  via           text NOT NULL CHECK (via IN ('api_key', 'chat')),
  key_prefix    text,
  client_name   text,
  server_slug   text,
  tool_name     text,
  exposed_name  text,
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'tool_error', 'error', 'timeout', 'unavailable', 'denied', 'not_found', 'rate_limited', 'quarantined')),
  error_message text,
  duration_ms   integer NOT NULL DEFAULT 0,
  args_preview  text
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_user_ts_idx ON audit_log (user_id, ts DESC);
CREATE INDEX audit_log_server_ts_idx ON audit_log (server_slug, ts DESC);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New chat',
  messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC);
