# Permanent Deployment: Supabase Edge Function

CloudBridge sekarang memakai satu Supabase Edge Function, sehingga tidak membutuhkan Render, tunnel, atau URL sementara.

URL API stabil:

```text
https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge
```

URL app iPhone:

```text
https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/
```

## 1. Supabase

Project aktif:

```text
riwayat smart relay
ajlkfzgpheegmwsnspxw
```

Database dan storage:

- `cloudbridge_devices`
- `cloudbridge_pairing_sessions`
- `cloudbridge_clipboard`
- `cloudbridge_files`
- `cloudbridge_maintenance`
- private Storage bucket `cloudbridge-files`
- `cloudbridge_admin_tokens`

RLS tetap aktif tanpa public policy karena semua akses tabel dan storage dilakukan server-side dari Edge Function.

Supabase Realtime Broadcast dipakai untuk sinyal update kecil. Isi clipboard dan file tidak dikirim lewat Realtime; Windows Agent tetap mengambil data lewat API bertoken setelah menerima sinyal.

## 2. Edge Function API

Source:

```text
supabase/functions/cloudbridge/index.ts
```

Config:

```toml
[functions.cloudbridge]
verify_jwt = false
```

`verify_jwt` dinonaktifkan karena function memakai bearer token internal: admin token dan device token hasil pairing.

Admin token hanya dipakai oleh Windows Agent/tray untuk membuat pairing code. Browser iPhone dan browser PC memakai device token dari tabel `cloudbridge_devices`.

## 3. GitHub Pages App

Source:

```text
docs/app/
```

GitHub Pages melayani HTML PWA karena Supabase Edge Functions tidak mendukung `text/html` sebagai halaman browser.

## 4. Windows

Konfigurasi `windows_agent/.env`:

```env
CLOUD_BRIDGE_BASE_URL=https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge
CLOUD_BRIDGE_TOKEN=<admin-token>
CLOUD_BRIDGE_DEVICE_ID=windows-CUKER
POLL_INTERVAL_MS=5000
DOWNLOAD_DIR=D:\Cloud Bridge
CLOUD_BRIDGE_APP_URL=https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/
CLOUD_BRIDGE_REALTIME_ENABLED=true
CLOUD_BRIDGE_SUPABASE_URL=https://ajlkfzgpheegmwsnspxw.supabase.co
CLOUD_BRIDGE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_c4VLFI_5vVD2FokNBuX1iw_44NApC27
CLOUD_BRIDGE_REALTIME_TOPIC=cloudbridge
CLOUD_BRIDGE_FALLBACK_POLL_INTERVAL_MS=300000
CLOUD_BRIDGE_LOCAL_CLIPBOARD_INTERVAL_MS=1000
CLOUD_BRIDGE_HEALTH_INTERVAL_MS=300000
```

Jalankan:

```powershell
.\start-windows-agent.ps1
```

Stop:

```powershell
.\stop-windows-agent.ps1
```

## 5. iPhone

1. Jalankan Windows Agent.
2. Dari tray icon CloudBridge, pilih `Show pairing link`.
3. Buka pairing link di iPhone.
4. Tap `Pair iPhone`.
5. Di Safari, tap Share lalu `Add to Home Screen`.
6. Untuk file dari Windows, buka tab `Files` lalu tap `Download`.

Untuk PC Web Manager, pilih `Open CloudBridge Manager` dari tray. Tray akan membuat pairing code singkat dan PWA otomatis claim sebagai device `windows-web`, tanpa mengirim admin token ke browser.

## 6. Storage Behavior

- Upload file masuk ke bucket private `cloudbridge-files`.
- File bersifat sementara dengan TTL default 24 jam.
- Setelah Windows download dan mengirim `ack`, file ditandai `downloaded`, tetapi object storage tidak langsung dihapus.
- Cleanup otomatis berjalan oportunistik dari Edge Function maksimal 1x per 24 jam.
- File unpinned yang sudah `downloaded` lebih dari 24 jam akan dihapus dari bucket dan database.
- File unpinned yang expired lebih dari 24 jam juga akan dihapus.
- File pinned tidak ikut cleanup sampai user melakukan unpin.
- File bisa dikirim dua arah: iPhone upload dari PWA, Windows upload dari tray menu `Send file to iPhone`.

## 7. Pin dan History

PWA manager di GitHub Pages memiliki tab:

- `Clipboard History`
- `Files History`

Kedua tab menyediakan tombol `Pin` / `Unpin`. Clipboard pinned tidak dihapus oleh cleanup 7 hari. File pinned tidak dihapus walaupun sudah downloaded atau expired.

Endpoint terkait:

```text
GET  /api/clipboard/history
POST /api/clipboard/{id}/pin
POST /api/clipboard/{id}/unpin
GET  /api/files/history
POST /api/files/{id}/pin
POST /api/files/{id}/unpin
POST /api/cleanup
```
