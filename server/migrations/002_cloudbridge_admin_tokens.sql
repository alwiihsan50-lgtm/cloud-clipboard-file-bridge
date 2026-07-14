create table if not exists public.cloudbridge_admin_tokens (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Windows Admin',
  token_hash text not null unique,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.cloudbridge_admin_tokens enable row level security;

