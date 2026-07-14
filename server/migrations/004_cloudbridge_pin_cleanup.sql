alter table public.cloudbridge_clipboard
  add column if not exists pinned boolean not null default false,
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by_device_id text;

alter table public.cloudbridge_files
  add column if not exists pinned boolean not null default false,
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by_device_id text;

create table if not exists public.cloudbridge_maintenance (
  key text primary key,
  last_cleanup_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.cloudbridge_maintenance enable row level security;

insert into public.cloudbridge_maintenance (key, last_cleanup_at)
values ('cleanup', null)
on conflict (key) do nothing;

create index if not exists cloudbridge_clipboard_cleanup_idx
  on public.cloudbridge_clipboard (pinned, created_at, version desc);

create index if not exists cloudbridge_clipboard_history_idx
  on public.cloudbridge_clipboard (pinned desc, version desc);

create index if not exists cloudbridge_files_cleanup_idx
  on public.cloudbridge_files (pinned, status, downloaded_at, expires_at);

create index if not exists cloudbridge_files_history_idx
  on public.cloudbridge_files (pinned desc, uploaded_at desc);
