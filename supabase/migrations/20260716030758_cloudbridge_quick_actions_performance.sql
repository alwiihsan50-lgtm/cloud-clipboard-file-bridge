alter table public.cloudbridge_devices
  add column if not exists access_scope text not null default 'full',
  add column if not exists parent_device_id text
    references public.cloudbridge_devices(device_id) on delete cascade;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cloudbridge_devices_access_scope_check'
  ) then
    alter table public.cloudbridge_devices
      add constraint cloudbridge_devices_access_scope_check
      check (access_scope in ('full', 'clipboard_quick'));
  end if;
end
$$;

create index if not exists cloudbridge_devices_parent_idx
  on public.cloudbridge_devices (parent_device_id, access_scope)
  where parent_device_id is not null;

create or replace function public.cloudbridge_storage_usage()
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(size), 0)::bigint
  from public.cloudbridge_files;
$$;

revoke all on function public.cloudbridge_storage_usage() from public;
revoke all on function public.cloudbridge_storage_usage() from anon;
revoke all on function public.cloudbridge_storage_usage() from authenticated;
grant execute on function public.cloudbridge_storage_usage() to service_role;
