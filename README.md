# agent-engineer-system

Sistem agent AI yang berperan sebagai satu tim development lengkap (PM, BA, QA, Backend/Frontend Engineer, Lead Engineer) yang bisa dikendalikan sepenuhnya lewat WhatsApp. Kirim instruksi lewat WhatsApp, agent akan clone/pull repo yang dimaksud, mengerjakan perubahan, menjalankan test, commit, push, dan (tergantung kebijakan project) membuka PR atau langsung merge ke branch utama — lalu membalas ke WhatsApp dengan ringkasan hasilnya.

Didesain untuk berjalan 24/7 di server, bukan di laptop kamu.

## Arsitektur

```
WhatsApp → Meta Cloud API → whatsapp-gateway (webhook) → orchestrator → Claude Agent SDK → git/GitHub
```

- **`apps/whatsapp-gateway`** — menerima webhook dari Meta, verifikasi signature, kirim balasan.
- **`apps/orchestrator`** — registry project, routing perintah, menjalankan sesi agent per task, audit log, kirim progress ke WA.
- **`workspaces/`** — clone lokal tiap repo yang terdaftar.
- **`infra/`** — Dockerfile, docker-compose, Caddyfile untuk deploy.

## 1. Siapkan kredensial

### Anthropic API key
Ambil dari [console.anthropic.com](https://console.anthropic.com/).

### GitHub token
Buat Personal Access Token (classic atau fine-grained) dengan akses `repo` ke semua repo yang ingin dikerjakan agent. Simpan sebagai `GITHUB_TOKEN`.

### WhatsApp Business Cloud API (Meta)
1. Buat app di [developers.facebook.com](https://developers.facebook.com/) → tambahkan produk **WhatsApp**.
2. Di halaman **API Setup**, catat: **Phone number ID** (`META_PHONE_NUMBER_ID`) dan **Temporary/Permanent access token** (`META_ACCESS_TOKEN`). Untuk pemakaian jangka panjang, generate System User token permanen di Business Settings, bukan token sementara.
3. Catat **App Secret** dari App Settings → Basic (`META_APP_SECRET`).
4. Tentukan sendiri `META_VERIFY_TOKEN` (string bebas) — akan dipakai saat setup webhook.
5. Webhook baru bisa diisi setelah server kamu jalan (lihat langkah 3), karena Meta akan melakukan GET request verifikasi ke `https://<domain>/webhook`.
6. Nomor WhatsApp kamu sendiri (format E.164 tanpa `+`, mis. `6281234567890`) dimasukkan ke `ALLOWED_SENDERS` dan `OWNER_WHATSAPP_NUMBER` — supaya hanya kamu yang bisa memerintah agent ini.

### Domain
Meta mewajibkan webhook HTTPS dengan sertifikat valid (self-signed ditolak). Arahkan sebuah domain/subdomain (A record) ke IP VPS kamu.

## 2. Siapkan VPS

Rekomendasi: VPS Ubuntu 22.04+ dengan Docker & Docker Compose terpasang (mis. Hetzner CX22, DigitalOcean droplet $6–12/bulan). Buka port 80 dan 443.

```bash
git clone <url-repo-ini> agent-engineer-system
cd agent-engineer-system
cp .env.example .env
# edit .env, isi semua nilai (lihat langkah 1)
docker compose -f infra/docker-compose.yml up -d --build
```

Cek log untuk pastikan semua service jalan:

```bash
docker compose -f infra/docker-compose.yml logs -f
```

## 3. Selesaikan setup webhook Meta

Setelah container jalan dan DNS domain kamu mengarah ke server:

1. Di Meta App → WhatsApp → Configuration → Webhook, isi:
   - **Callback URL**: `https://<domain>/webhook`
   - **Verify token**: nilai `META_VERIFY_TOKEN` di `.env`
2. Klik **Verify and Save** — Meta akan GET ke `/webhook`, dan whatsapp-gateway akan membalas challenge-nya.
3. Subscribe ke field **messages**.

## 4. Pakai lewat WhatsApp

Kirim pesan dari nomor yang ada di `ALLOWED_SENDERS` ke nomor WhatsApp Business kamu:

```
tambah project toko-online https://github.com/namamu/toko-online.git
```

Agent akan clone repo tersebut dan menjadikannya project aktif untuk chat ini. Lalu beri instruksi bebas:

```
tambahin endpoint /health yang return status 200 dan ringkas dependency yang out of date
```

Perintah lain:

```
daftar project        → lihat semua project terdaftar
pakai <nama>           → ganti project aktif
status                 → lihat task yang sedang berjalan
stop / batalkan         → hentikan task yang sedang berjalan
bantuan                → tampilkan daftar perintah
```

## Kebijakan merge per-project

Default: agent commit langsung ke branch utama repo (`auto_merge = 'direct'`) — sesuai preferensi otonomi penuh. Untuk mengubah suatu project supaya lewat PR dulu, update kolom `auto_merge` jadi `'pr'` di tabel `projects` (`data/orchestrator.sqlite`).

## Catatan keamanan

- Hanya nomor di `ALLOWED_SENDERS` yang perintahnya diproses.
- Setiap command bash/git yang dijalankan agent dicatat di tabel `audit_log`.
- Kirim `stop`/`batalkan` kapan saja untuk menghentikan task yang sedang berjalan — ini jaring pengaman minimal karena agent berjalan otonom penuh tanpa approval per langkah.
- `.env` menyimpan kredensial sensitif — jangan commit ke git (`.gitignore` sudah menghandle ini).

## Pengembangan lokal

```bash
npm install
cp .env.example .env   # isi minimal ANTHROPIC_API_KEY, GITHUB_TOKEN, INTERNAL_SHARED_SECRET, dst.
npm run dev:orchestrator   # terminal 1
npm run dev:gateway        # terminal 2
```

Untuk testing webhook lokal tanpa domain publik, gunakan tunnel (ngrok/cloudflared) ke port `whatsapp-gateway` (default 3000).

## Fase lanjutan (belum diimplementasikan)

- Deploy otomatis aplikasi yang dibuat agent (Vercel/Render/DigitalOcean API) supaya langsung dapat URL live.
- Role PM/BA/QA/Dev sebagai subagent terpisah, bukan satu system prompt.
- Sandbox Docker per-task untuk isolasi eksekusi.
- Dukungan lampiran WhatsApp (gambar, voice note).
