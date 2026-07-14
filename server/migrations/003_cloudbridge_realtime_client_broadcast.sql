-- CloudBridge uses Supabase Realtime Broadcast from trusted clients/PWA after
-- the API write succeeds. No table triggers are required.
drop trigger if exists cloudbridge_clipboard_realtime_insert on public.cloudbridge_clipboard;
drop trigger if exists cloudbridge_files_realtime_insert on public.cloudbridge_files;
drop function if exists public.cloudbridge_broadcast_clipboard_insert();
drop function if exists public.cloudbridge_broadcast_file_insert();
