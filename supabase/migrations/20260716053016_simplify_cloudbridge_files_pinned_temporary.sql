-- Preserve every existing object before removing the file-manager hierarchy.
update public.cloudbridge_files
set
  pinned = true,
  pinned_at = coalesce(pinned_at, now()),
  pinned_by_device_id = coalesce(
    pinned_by_device_id,
    'migration-file-manager-removal'
  ),
  folder_id = null,
  trashed_at = null,
  trashed_from_folder_id = null,
  updated_at = now();

alter table public.cloudbridge_files
  drop column if exists folder_id,
  drop column if exists trashed_at,
  drop column if exists trashed_from_folder_id;

drop table if exists public.cloudbridge_file_folders;
drop function if exists public.cloudbridge_storage_usage();

create index if not exists cloudbridge_files_pinned_uploaded_idx
  on public.cloudbridge_files (pinned, uploaded_at desc);
