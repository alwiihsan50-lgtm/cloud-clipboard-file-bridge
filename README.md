# Cloud Clipboard & File Bridge

CloudBridge menyinkronkan clipboard teks dan file antara iPhone dan Windows 11 lewat internet. Versi utama sekarang berjalan penuh di Supabase, tanpa Render, tunnel, atau URL sementara.

URL API stabil:

```text
https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge
```

URL app iPhone:

```text
https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/
```

## Komponen

- `supabase/functions/cloudbridge/` - backend API sebagai Supabase Edge Function.
- `docs/app/` - PWA iPhone yang disajikan lewat GitHub Pages.
- `windows_agent/` - agent Windows Python untuk membaca clipboard lokal, mengambil update cloud, mengunduh file, dan memberi notifikasi.
- `server/migrations/` - SQL setup tabel, bucket, dan token admin CloudBridge.
- `server/` - backend FastAPI lama untuk referensi lokal/legacy, bukan jalur utama.

## Realtime

CloudBridge memakai Supabase Realtime Broadcast untuk sinyal kecil:

- `clipboard`: ada clipboard baru di cloud.
- `file`: ada file baru di cloud.

Payload Realtime tidak berisi isi clipboard atau binary file. Setelah menerima sinyal, Windows Agent tetap mengambil data lewat API bertoken. Polling cloud tetap ada sebagai fallback lambat setiap 5 menit.

## Jalur Utama: Supabase Edge Function

Backend utama ada di project Supabase `riwayat smart relay` dengan ref `ajlkfzgpheegmwsnspxw`.

Endpoint API yang tersedia di Supabase:

```text
GET  /health
GET  /api/me
POST /api/pairing/create
POST /api/pairing/claim
POST /api/clipboard/push
GET  /api/clipboard/latest
GET  /api/clipboard/history
POST /api/clipboard/{id}/pin
POST /api/clipboard/{id}/unpin
POST /api/files/upload
GET  /api/files/pending
GET  /api/files/history
GET  /api/files/{id}/download
POST /api/files/{id}/ack
POST /api/files/{id}/pin
POST /api/files/{id}/unpin
POST /api/cleanup
```

Endpoint publik hanya `/health` dan `/api/pairing/claim`. Endpoint lain memakai:

```http
Authorization: Bearer <token>
```

Token admin disimpan sebagai hash SHA-256 di tabel `cloudbridge_admin_tokens`. Token device iPhone disimpan sebagai hash SHA-256 di tabel `cloudbridge_devices`.

## Menjalankan di Windows Ini

File konfigurasi agent ada di `windows_agent/.env` dan sudah diarahkan ke URL Supabase stabil.

Jalankan agent:

```powershell
.\start-windows-agent.ps1
```

Stop agent:

```powershell
.\stop-windows-agent.ps1
```

Folder penerimaan file:

```text
D:\Cloud Bridge
```

Windows Agent membuka koneksi Supabase Realtime supaya update dari iPhone terasa instan. Polling cloud fallback default adalah `300000ms` atau 5 menit.

## Pairing iPhone

1. Jalankan Windows Agent.
2. Dari tray CloudBridge, pilih menu untuk membuat pairing link.
3. Buka link `https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/?code=...` di iPhone.
4. Tap `Pair iPhone`.
5. Di Safari iPhone, gunakan `Add to Home Screen` supaya CloudBridge tampil seperti app.

## Data dan Konflik

- Clipboard menyimpan `id`, `content`, `source`, `version`, `created_at`, dan `device_id`.
- Server memakai aturan `last-write-wins` berdasarkan urutan `version` dari database.
- Windows Agent mengirim `device_id`; endpoint latest tidak mengirim echo balik ke device pengirim.
- File masuk ke bucket private `cloudbridge-files`.
- Clipboard dan file punya status `pinned`; item pinned tidak ikut cleanup otomatis.
- Setelah Windows mengirim `ack`, file ditandai `downloaded`, tetapi object storage tidak langsung dihapus.
- Cleanup otomatis berjalan oportunistik maksimal 1x per 24 jam setelah operasi tulis penting.
- Clipboard unpinned disimpan 7 hari.
- File unpinned dihapus cleanup jika sudah `downloaded` lebih dari 24 jam, atau expired lebih dari 24 jam.
- TTL file default adalah 24 jam, tetapi file pinned tetap bisa disimpan sampai user melakukan unpin.

## CloudBridge Manager

PWA iPhone memiliki tab `Clipboard History` dan `Files History` untuk melihat item terbaru dan melakukan `Pin` / `Unpin`.

Di Windows tray, menu `Open CloudBridge Manager` membuka PWA manager:

```text
https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/
```

## Catatan PWA

Supabase Edge Functions tidak dipakai untuk halaman PWA karena response HTML dari Edge Function dikirim sebagai `text/plain`. Karena itu app iPhone disajikan dari GitHub Pages, sementara semua operasi data tetap lewat Supabase API.

## Legacy Lokal

Folder `server/` dan test FastAPI lama masih dipertahankan sebagai referensi development. Jalur produksi/pribadi sekarang adalah Supabase Edge Function, jadi tidak perlu Render, Railway, Fly.io, Cloudflare tunnel, atau URL yang berubah saat restart.
