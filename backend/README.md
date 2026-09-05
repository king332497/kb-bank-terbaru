# Realtime Presence Backend

Backend ini hanya menerima telemetry alur yang sudah di-allowlist:

- `sessionId`
- `status` (`online` / `offline`)
- `flowPage`
- `flowStep`
- timestamp yang ditetapkan server

Backend **tidak menerima isi form**, password, OTP/kode verifikasi, PIN, nomor rekening, nominal pinjaman, atau data kredensial lain.

## Jalankan lokal

```bash
cd backend
ADMIN_TOKEN="ganti-dengan-secret-random-minimal-24-karakter" \
ALLOWED_ORIGINS="http://localhost:8000,http://127.0.0.1:8000" \
PORT=8787 \
node server.js
```

Jalankan frontend, misalnya:

```bash
python3 -m http.server 8000
```

Pada localhost, `realtime-config.js` otomatis menggunakan port `8787`.

## Deployment

1. Deploy folder `backend/` ke layanan Node yang mendukung koneksi HTTP streaming/SSE jangka panjang, misalnya Render atau Railway.
2. Set environment variable:
   - `ADMIN_TOKEN`
   - `ALLOWED_ORIGINS=https://domain-frontend-anda.example`
   - `PORT` biasanya diberikan platform otomatis.
3. Edit `realtime-config.js` dan isi `DEPLOYED_BACKEND_URL` dengan URL HTTPS backend.
4. Buka Admin Panel dengan token melalui hash, sehingga token tidak dikirim sebagai Referer:

```text
admin-simulasi.html#rt_token=ADMIN_TOKEN_ANDA
```

Hash akan dihapus dari address bar setelah dibaca. Token hanya disimpan di `sessionStorage` tab admin dan dikirim ke endpoint autentikasi melalui header `X-Admin-Token`; koneksi SSE memakai tiket singkat sekali pakai.
