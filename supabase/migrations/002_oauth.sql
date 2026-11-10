-- OAuth 2.1 authorization server for MCP clients (public clients + PKCE).
-- Codes and tokens are stored ONLY as SHA-256 hashes (hex). The plain values are shown to the client once.
-- RLS is on with NO policies: anon/authenticated can never read these tables. Only the backend
-- (service role, which bypasses RLS) touches them.

-- Dynamic client registration (RFC 7591). Public clients only, so there is no client secret.
create table if not exists oauth_clients (
  client_id text primary key,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  client_name text not null default 'MCP client',
  created_at timestamptz not null default now()
);

-- One-time authorization codes (valid 5 minutes).
create table if not exists oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  used boolean not null default false
);
create index if not exists oauth_codes_expires_idx on oauth_codes(expires_at);

-- Access tokens (1 hour) + refresh tokens (30 days), one row per pair.
-- A rotated refresh token keeps its row with revoked = true, so reuse of an old refresh token can be detected.
create table if not exists oauth_tokens (
  token_hash text primary key,
  refresh_hash text not null unique,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked boolean not null default false
);
create index if not exists oauth_tokens_user_client_idx on oauth_tokens(user_id, client_id);
create index if not exists oauth_tokens_refresh_exp_idx on oauth_tokens(refresh_expires_at);

alter table oauth_clients enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;

-- Defense in depth: no policies exist, and the public API roles also lose table privileges.
revoke all on oauth_clients, oauth_codes, oauth_tokens from anon, authenticated;
