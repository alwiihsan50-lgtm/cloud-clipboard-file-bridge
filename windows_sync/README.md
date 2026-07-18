# CloudBridge Folder Sync

Folder `D:\Cloud Bridge` disinkronkan dua arah ke bucket private
`cloudbridge-sync` melalui gateway WebDAV CloudBridge. Gateway hanya dapat
mengakses bucket sinkronisasi dan tidak dapat membaca bucket transfer aplikasi.

Runtime Windows:

- `rclone` backend WebDAV
- task `CloudBridge Folder Sync`, berjalan setiap satu menit
- config dan log di `%LOCALAPPDATA%\CloudBridge\Sync`

Endpoint iPhone/File Provider:

```text
https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge/webdav/
```

Gunakan aplikasi File Provider yang mendukung WebDAV, misalnya Owlfiles, lalu
aktifkan lokasinya dari aplikasi Files. Username dan password instalasi lokal
tersimpan di `%LOCALAPPDATA%\CloudBridge\Sync\iPhone-setup.txt` dengan akses
hanya untuk akun Windows saat ini.

