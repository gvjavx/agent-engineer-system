# agent-engineer-system

Sistem agent AI yang berperan sebagai satu tim development lengkap (PM, BA, QA, Backend/Frontend Engineer, Lead Engineer) yang bisa dikendalikan sepenuhnya lewat WhatsApp. Kirim instruksi lewat WhatsApp, agent akan clone/pull repo yang dimaksud, mengerjakan perubahan, menjalankan test, commit, push, dan (tergantung kebijakan project) membuka PR atau langsung merge ke branch utama — lalu membalas ke WhatsApp dengan ringkasan hasilnya.

Didesain untuk berjalan 24/7 di server, bukan di laptop kamu.

## Arsitektur

```
WhatsApp → Meta Cloud API → whatsapp-gateway (webhook) → orchestrator → agent loop (Gemini/Qwen/OpenRouter) → git/GitHub
```

- **`apps/whatsapp-gateway`** — menerima webhook dari Meta, verifikasi signature, kirim balasan.
- **`apps/orchestrator`** — registry project, routing perintah, menjalankan sesi agent per task, audit log, kirim progress ke WA.
  - **`src/agent/`** — tool-calling loop custom (bukan Claude Agent SDK): `loop.ts` (loop utamanya), `tools.ts` (tool `bash`/`read_file`/`write_file`/`edit_file`), `providers/` (adapter tiap penyedia AI). Provider dicoba berurutan sesuai `AI_PROVIDER_ORDER`; kalau satu gagal/kena rate limit, otomatis pindah ke provider berikutnya tanpa mengulang task dari awal.
- **`apps/cli`** — front terminal opsional; nyetir agent yang sama lewat route `/cli/*` di orchestrator (lihat "Pakai lewat CLI").
- **`workspaces/`** — clone lokal tiap repo yang terdaftar.
- **`infra/`** — Dockerfile, docker-compose, Caddyfile untuk deploy.

## 1. Siapkan kredensial

### AI provider gratis (minimal 1, boleh lebih untuk fallback)
Set urutan providernya lewat `AI_PROVIDER_ORDER` di `.env` (default: `gemini,openrouter,qwen`). Cuma provider yang namanya ada di daftar itu yang env var-nya wajib diisi — mulai dari 1 provider saja tidak masalah.

- **Gemini** (paling gampang, direkomendasikan sebagai provider pertama): ambil API key gratis tanpa kartu kredit dari [Google AI Studio](https://aistudio.google.com/apikey). Default model-nya `gemini-3.1-flash-lite` — varian "lite" empiris dapat kuota gratis yang lebih longgar; model flagship/alias `-latest` sering cuma dapat 5 request/menit gratis, terlalu ketat untuk satu giliran agent yang butuh banyak tool call beruntun. Google juga rutin mempensiunkan nama model dari tier gratis (`gemini-2.5-flash` dan `gemini-2.0-flash` sama-sama berhenti tersedia untuk API key baru) — kalau model default ini mulai error 429/404, cek daftar & limit terkini di [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits).
- **OpenRouter**: signup email di [openrouter.ai/keys](https://openrouter.ai/keys), tanpa kartu kredit. Menyatukan puluhan model gratis (`:free`) dari banyak vendor lewat satu API — default-nya `qwen/qwen3-coder:free`. Cek [openrouter.ai/models](https://openrouter.ai/models) untuk daftar model gratis terkini (bisa berubah sewaktu-waktu). Limit: 20 request/menit.
- **Qwen** (via Alibaba Cloud DashScope, region International/Singapore): butuh akun Alibaba Cloud, agak lebih ribet setup-nya dibanding dua di atas. Akun baru dapat kuota gratis 1 juta token input + 1 juta output, **berlaku 90 hari** sejak aktivasi — setelah itu butuh kredit berbayar.

**Lebih dari satu API key untuk provider yang sama**: tiap `<NAMA>_API_KEY` (termasuk `GEMINI_API_KEY`) boleh diisi beberapa key sekaligus, dipisah koma — `GEMINI_API_KEY=key1,key2,key3`. Berguna kalau kamu punya beberapa akun/key gratis buat provider yang sama sebagai cadangan. Kalau key yang lagi dipakai kena limit/habis kuota, agent otomatis coba key berikutnya dari provider yang sama dulu — baru pindah ke provider lain kalau semua key provider itu sudah dicoba. `daftar model` menampilkan tiap key secara terpisah (`gemini (key 2/3)`, dst) kalau ada lebih dari satu.

### Memasang AI provider lain (tanpa ubah kode)

Selain Gemini/OpenRouter/Qwen, kamu bisa colokkan provider gratis/berbayar lain apa saja **selama API-nya OpenAI-compatible** (chat completions endpoint dengan format `messages`/`tools` standar — ini mencakup mayoritas provider: Groq, Mistral, Cerebras, Together AI, Fireworks, DeepSeek langsung, dll). Tidak perlu sentuh kode sama sekali, cukup 4 baris di `.env`:

1. Tambahkan nama provider (bebas, huruf kecil) ke `AI_PROVIDER_ORDER`, contoh: `AI_PROVIDER_ORDER=gemini,openrouter,qwen,groq`
2. Isi tiga env var dengan pola `<NAMA_KAPITAL>_API_KEY`, `<NAMA_KAPITAL>_BASE_URL`, `<NAMA_KAPITAL>_MODEL`. Untuk contoh `groq` di atas:
   ```
   GROQ_API_KEY=gsk_...
   GROQ_BASE_URL=https://api.groq.com/openai/v1
   GROQ_MODEL=llama-3.3-70b-versatile
   ```

Itu saja — orchestrator otomatis mendeteksi dan mem-build provider baru itu saat startup (lihat `apps/orchestrator/src/config.ts`, fungsi generiknya di situ). Urutan di `AI_PROVIDER_ORDER` = urutan fallback: kalau provider pertama error/kena rate limit di tengah task, otomatis lanjut ke provider berikutnya tanpa mengulang task dari awal (lihat `apps/orchestrator/src/agent/loop.ts`).

Catatan:
- `qwen` dan `openrouter` sudah punya default bawaan untuk `BASE_URL`/`MODEL` (lihat daftar di atas), jadi buat keduanya cukup isi `_API_KEY`-nya saja kalau mau pakai default. Nama lain **wajib** isi ketiga env var-nya (base URL provider itu tidak ada default-nya).
- Kalau providernya bukan OpenAI-compatible (beda format request/response sama sekali, seperti Gemini), itu butuh kode adapter baru — contoh lengkapnya ada di `apps/orchestrator/src/agent/providers/gemini.ts`.

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

### Alternatif: GCP dengan auto-deploy tiap push

Kalau mau host di GCP dan biar tiap `git push` ke `main` langsung ke-deploy sendiri (tanpa SSH manual tiap kali ada perubahan), pakai `infra/gcp/setup.sh` alih-alih langkah VPS di atas.

Sekali jalan, script ini bikin: VM Compute Engine (Ubuntu + Docker, isi `.env` kamu disimpan sebagai Secret Manager secret, bukan plaintext di disk), static IP dengan domain gratis `<ip>.sslip.io` (dapat sertifikat HTTPS valid otomatis lewat Caddy, gak perlu beli domain), dan Workload Identity Federation supaya GitHub Actions bisa SSH deploy tanpa nyimpen service account key di mana pun.

```bash
gcloud auth login                 # kalau belum
gcloud config set project <project-id>
cp .env.example .env && $EDITOR .env   # isi semua kredensial (lihat langkah 1)
VM_MACHINE_TYPE=e2-medium ./infra/gcp/setup.sh   # e2-small lebih murah kalau mau hemat
```

Di akhir, script ini nampilin domain sslip.io-nya dan 5 nilai (`GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `GCP_ZONE`, `GCP_VM_NAME`) buat ditaruh sebagai **repo variable** GitHub (Settings → Secrets and variables → Actions → tab *Variables*, bukan *Secrets* — nilainya emang bukan rahasia). Setelah itu, `.github/workflows/deploy.yml` yang jalanin sisanya: tiap push ke `main`, workflow SSH ke VM lewat IAP tunnel dan jalankan `infra/gcp/redeploy.sh` (`git pull` + refresh secret + `docker compose up -d --build`).

Ganti isi kredensial (API key, token) belakangan? Update Secret Manager, bukan `.env` di VM langsung — nanti ke-overwrite tiap deploy:

```bash
gcloud secrets versions add agent-engineer-env --data-file .env
```

lalu redeploy (push apa saja ke `main`, atau SSH manual `sudo bash /opt/agent-engineer-system/infra/gcp/redeploy.sh`) biar VM narik versi terbaru.

## 3. Selesaikan setup webhook Meta

Setelah container jalan dan DNS domain kamu mengarah ke server:

1. Di Meta App → WhatsApp → Configuration → Webhook, isi:
   - **Callback URL**: `https://<domain>/webhook`
   - **Verify token**: nilai `META_VERIFY_TOKEN` di `.env`
2. Klik **Verify and Save** — Meta akan GET ke `/webhook`, dan whatsapp-gateway akan membalas challenge-nya.
3. Subscribe ke field **messages**.
4. **Penting** — baca [Troubleshooting: webhook berhenti terima pesan](#troubleshooting-webhook-berhenti-terima-pesan) di bawah sebelum menganggap ini selesai. Subscribe di step 3 sering terlihat berhasil di UI tapi sebenarnya tidak tersimpan.

## 4. Pakai lewat WhatsApp

Kirim pesan dari nomor yang ada di `ALLOWED_SENDERS` ke nomor WhatsApp Business kamu:

```
tambah project toko-online https://github.com/namamu/toko-online.git
```

Agent akan clone repo tersebut dan menjadikannya project aktif untuk chat ini. Lalu beri instruksi bebas:

```
tambahin endpoint /health yang return status 200 dan ringkas dependency yang out of date
```

Agent gak langsung eksekusi — dia balas dulu dengan rencana kerja (departemen mana yang ngerjain apa, lihat [Model AI per departemen](#model-ai-per-departemen) di bawah), dan baru mulai setelah kamu konfirmasi.

Konfirmasi ini (dan beberapa pesan lain — pilih project yang ambigu, hasil pencarian model) muncul sebagai **tombol/daftar pilihan asli WhatsApp** yang tinggal di-tap, bukan cuma teks yang harus diketik ulang. Kalau WhatsApp client-nya gak support tombol interaktif (jarang terjadi), tetap bisa dijawab dengan ngetik biasa ("ya"/"tidak"/nama project) — teksnya tetap dikenali sama seperti sebelumnya.

Perintah lain:

```
daftar project                        → lihat semua project terdaftar
tambah project <nama> <owner/repo>   → shorthand, gak wajib URL lengkap
tambah folder <nama> <path>           → daftarkan folder lokal di server (bukan repo git)
ganti nama project <lama> <baru>     → rename alias
pindah project ke pr / ke direct     → ganti kebijakan merge project aktif
pakai <nama>                          → ganti project aktif
daftar model                          → cek AI provider + model per departemen, masih bisa dipakai atau tidak
pakai model <nama>                    → model AI default (dipakai departemen yang belum punya model sendiri)
pakai model <departemen> <nama>       → model AI khusus satu departemen (manajemen/dev/desain/qa/infra/bisnis); "reset" buat balik ke default
status                                → lihat task yang sedang berjalan + ringkasan 7 hari
log task terakhir                     → langkah-langkah (command/edit/error) dari task terakhir
lanjutin task terakhir               → jalanin ulang instruksi task terakhir (konfirmasi rencana lagi)
stop / batalkan                       → hentikan task yang sedang berjalan
review PR <nomor>                     → baca diff PR di project aktif, kasih review, konfirmasi dulu sebelum posting komentar ke PR
daftar PR                            → lihat PR yang lagi kebuka (non-draft bisa langsung di-tap buat merge)
merge PR <nomor>                     → squash-merge PR + hapus branch-nya (konfirmasi dulu)
kerjain issue <nomor>                → baca issue GitHub di project aktif, susun rencana, garap setelah konfirmasi (PR nge-link "Closes #<nomor>")
batalin yang barusan                 → revert commit dari task terakhir di project aktif (konfirmasi dulu, history gak dihapus)
diff terakhir                        → kirim patch lengkap task terakhir sebagai lampiran file
atur cek test <cmd> / atur cek lint <cmd> → command yang dijalanin sebelum commit; gagal = commit dibatalin ("atur cek test off" buat matiin)
jadwalkan tiap <kapan>: <instruksi>   → task rutin, mis. "jadwalkan tiap senin jam 9: update dependencies"
tanya: <pertanyaan>                  → nanya soal kode di project aktif tanpa ngubah apa-apa (read-only)
deploy                               → deploy project aktif ke Vercel, balikin URL live (butuh VERCEL_TOKEN)
screenshot                           → nyalain dev server project aktif, jepret tampilannya, kirim gambarnya
di <repo1>, <repo2>: <instruksi>     → instruksi yang sama di beberapa project sekaligus (paralel)
daftar jadwal / hapus jadwal <nomor>  → lihat & batalkan task terjadwal
bantuan                               → tampilkan daftar perintah
```

## Batalin task terakhir

`batalin yang barusan` (atau `undo`, `batalin task terakhir`) — buat project git aktif, cari task terakhir yang beneran commit + push, tampilin instruksinya, minta konfirmasi. Kalau "ya": agent `git revert` semua commit dari task itu jadi satu commit revert baru di branch utama, terus push. History-nya gak dihapus — cuma ditambahin.

Yang di-revert cuma commit yang task itu sendiri bikin (dicatat dari work branch-nya pas selesai), jadi perubahan orang lain yang nyempil di antara nggak ikut kebalik. Kalau commit-nya udah ke-rewrite (squash/rebase) sampai nggak kelacak, atau revert-nya bentrok, auto-revert berhenti dan agent bilang biar dibenerin manual. Jaring pengaman buat mode `auto_merge = 'direct'` (default) yang push langsung ke branch utama tanpa PR.

## Deploy ke Vercel

`deploy` (atau `publish`) — deploy project aktif ke Vercel lewat CLI-nya (`npx vercel --prod`), balikin URL production-nya. Butuh `VERCEL_TOKEN` di `.env` (bikin di [vercel.com/account/tokens](https://vercel.com/account/tokens)) — tanpa itu command-nya cuma bilang perlu diisi dulu. Deteksi framework-nya diserahin ke Vercel (zero-config), jadi mayoritas repo Next/Vite/CRA/static langsung jalan; yang gak kebangun ngasih error dari CLI-nya. Timeout 9 menit (unduhan CLI pertama kali bisa lama).

Abis deploy sukses, URL-nya di-hit sekali (smoke check — 200 atau enggak) dan, kalau `SCREENSHOT_ENABLED`, dijepret sekalian terus dikirim.

## Screenshot tampilan

`screenshot` (atau `jepret`, `ss`) — buat project aktif: deteksi script `dev`/`preview`/`start` di `package.json`, `npm install` dulu kalau `node_modules` belum ada, nyalain dev server-nya, tunggu dia ngeprint URL localhost, terus jepret full-page pakai headless Chromium dan kirim PNG-nya ke chat. Dev server-nya selalu dimatiin abis itu (kill process group).

Chromium-nya build `@sparticuz/chromium` (~60MB di image, unpack ke `/tmp` pas launch pertama) plus beberapa shared library yang ditambahin di `orchestrator.Dockerfile`. Di mesin dev tanpa library itu (Windows/Mac), command-nya gagal dengan pesan jelas — jalan beneran cuma di server Linux. `SCREENSHOT_ENABLED=false` buat matiin.

## Instruksi ke beberapa repo sekaligus

`di <repo1>, <repo2>, ...: <instruksi>` — mis. `di api-gateway, auth-service: bump dependency X terus jalanin test`. Agent klasifikasi departemen **sekali** buat instruksi itu, tunjukin satu rencana yang nyakup semua repo, dan setelah kamu konfirmasi sekali, tiap repo dapet task-nya sendiri yang jalan paralel (dibatasi `MAX_CONCURRENT_TASKS`). Satu repo gagal gak ganggu yang lain — masing-masing lapor hasilnya sendiri. Nama repo-nya harus persis alias yang kedaftar (kalau ada yang gak dikenal atau ada spasi, dianggap kalimat biasa dan gak ke-trigger).

## Tanya-jawab soal kode (read-only)

`tanya: <pertanyaan>` — mis. `tanya: gimana alur auth di project ini` atau `tanya: kenapa ada file scripts/foo.ts`. Agent baca-baca kode di project aktif (grep/find/`git log`/baca file, plus potongan RAG kalau nyala) terus jawab langsung — **tanpa** pipeline, tanpa branch, tanpa commit. Tool tulis (`write_file`/`edit_file`) dimatiin dan command bash yang keliatan mau ngubah sesuatu (commit/install/hapus/redirect) ditolak. Tanda titik dua wajib biar gak ketuker sama ngobrol biasa.

## Pakai lewat CLI

Selain WhatsApp, agent yang sama bisa dikendaliin dari terminal. Mati secara default.

**Nyalain di orchestrator:** set `CLI_ENABLED=true` di `.env`, restart orchestrator-nya. Aksesnya digerbangi `INTERNAL_SHARED_SECRET` — cuma yang punya secret itu yang bisa masuk.

**Install di device yang sama dengan orchestrator** (paling gampang):

```bash
npm install && npm run build          # sekali, di root repo
npm run cli                           # REPL — ketik instruksi baris per baris
npm run cli "tambahin endpoint /health"   # sekali jalan: kirim, print balasan sampai sepi, keluar
npm run cli --wait=30 "review PR 12"      # jeda 30 detik sebelum dianggap sepi
```

Mau jadi command global `mas-ade`:

```bash
npm i -g ./apps/cli        # atau: cd apps/cli && npm link
mas-ade "status"
```

**Install di device lain** (orchestrator di VPS): port orchestrator (4000) sengaja nggak diexpose ke internet, jadi tembus lewat SSH tunnel:

```bash
ssh -N -L 4000:localhost:4000 user@vps-kamu      # biarin jalan di terminal lain
# di device, set INTERNAL_SHARED_SECRET (sama persis dengan yang di VPS) + ORCHESTRATOR_URL=http://localhost:4000
git clone <repo-ini> && cd agent-engineer-system && npm i -g ./apps/cli
INTERNAL_SHARED_SECRET=... ORCHESTRATOR_URL=http://localhost:4000 mas-ade "status"
```

(Kalau device-nya nggak punya checkout repo, `apps/cli` cuma butuh satu file + `dotenv` — atau nol dependency kalau env var-nya kamu `export` langsung. dotenv-nya opsional.)

Jangan expose `/cli/*` langsung ke internet lewat Caddy kecuali kamu terima risikonya: secret-nya jadi bearer token di jalur publik, bocor = kendali penuh atas agent. SSH tunnel jauh lebih aman.

**Cara kerjanya:** CLI nyambung ke orchestrator yang lagi jalan (`ORCHESTRATOR_URL`, default `http://localhost:4000`) — tiap baris di-`POST` ke `/cli/message`, balasan di-stream balik lewat `/cli/stream` (SSE). Pakai satu identitas percakapan tetap (`CLI_SENDER_ID`, default `cli`) yang **terpisah** dari nomor WhatsApp — `pakai <project>`, memori, dan project aktifnya sendiri, kekunci lintas run. Semua command WhatsApp jalan di sini juga; tombol pilihan ditampilin sebagai `[id] label` yang tinggal diketik. Gambar/dokumen/voice cuma muncul sebagai catatan `[file: ...]`.

## Kebijakan merge per-project

Default: agent commit langsung ke branch utama repo (`auto_merge = 'direct'`) — sesuai preferensi otonomi penuh. Untuk mengubah suatu project supaya lewat PR dulu, ketik `pindah project ke pr` dari WhatsApp (project aktif), atau `pindah project ke direct` buat balik. Bisa juga edit kolom `auto_merge` langsung di tabel `projects` (`data/orchestrator.sqlite`).

## Disiplin kode minimal (default, hemat token)

Setiap task — di semua mode (git, folder lokal, tiap fase pipeline) — otomatis dapat instruksi "lazy senior developer" di system prompt-nya (diadaptasi dari [ponytail](https://github.com/dietrichgebert/ponytail)): sebelum nulis kode, agent wajib naik satu-satu "tangga" ini dan berhenti di anak tangga pertama yang cocok — apa ini emang perlu ada (YAGNI) → udah ada di codebase → stdlib bisa → fitur native platform → dependency yang udah terpasang → bisa satu baris → baru terakhir, tulis kode seminimal mungkin yang benar. Ini gak mengorbankan kebenaran — validasi input, penanganan error, dan requirement eksplisit tetap wajib; "minimal" artinya solusi terkecil yang *benar*, bukan asal potong. Diff lebih kecil = lebih sedikit token dibaca/ditulis/direview, dan lebih sedikit kode yang harus dirawat ke depannya. Lihat `apps/orchestrator/src/agent/systemPrompt.ts` (`SHARED_MINIMAL_CODE_RULES`) kalau mau ubah teksnya.

## Gate test/lint sebelum commit

Nyala secara default (`COMMIT_CHECKS_ENABLED`). Sebelum agent `git commit`, command test/lint project itu dijalanin dulu — kalau exit-nya bukan 0, commit-nya dibatalin dan output-nya dibalikin ke agent buat dibenerin. Sama kerasnya dengan secret scan: gak ada override lewat WhatsApp, agent harus beresin dulu.

Command-nya kedeteksi otomatis dari `package.json` pas project didaftarin — `npm test` / `npm run lint` (atau `pnpm`/`yarn` kalau ada lockfile-nya). Project non-npm atau yang mau di-override: `atur cek test <cmd>` / `atur cek lint <cmd>` di WhatsApp (operasinya di project aktif), atau `atur cek test off` buat matiin salah satunya. `status` nampilin cek yang aktif buat project itu.

Check-nya jalan di sandbox yang sama dengan tool `bash` (env scrub + `bubblewrap` di Linux). Timeout 10 menit per command.

Selain itu, tiap task git yang selesai diff-nya discan cepat (deterministik, tanpa panggilan AI) buat hal yang biasanya kesangkut nggak sengaja — `debugger`, test yang di-`.only(`, `console.debug`. Kalau ketemu, dikasih tau di pesan "udah selesai". Ini cuma peringatan, nggak nge-blok apa-apa.

## Pantau CI setelah push

Nyala secara default (`CI_WATCH_ENABLED`). Begitu task git selesai dan push, agent nge-poll GitHub Actions buat commit itu (lewat `gh`, sama kayak `review PR`). Hasilnya:

- **Lulus** → satu baris "CI di ... lulus".
- **Gagal** → potongan log kegagalan + tombol Ya/Tidak. Tap "Ya" bikin task baru dari log itu — agent nyari penyebabnya, benerin, commit + push lagi (kalau masalahnya di file workflow-nya, itu juga dibetulin).
- Repo tanpa Actions, atau yang run-nya gak kelar dalam `CI_WATCH_TIMEOUT_MINUTES` (default 20), diem aja.

Kalau `CI_WATCH_AUTO_REVERT=true` dan project-nya mode `direct`: begitu CI merah, commit task itu (cuma punya dia sendiri) langsung di-revert biar main hijau lagi, terus fix-nya ditawarin di atas branch yang udah bersih.

Poll-nya jalan di background, gak nahan antrian task project itu. Kalau pas log kegagalan dateng kamu lagi di tengah wizard lain, agent cuma ngabarin tanpa tombol biar gak numpuk.

## Konteks kode otomatis (RAG) — opsional

Mati secara default. Kalau `RAG_ENABLED=true` di `.env`, tiap project yang didaftarkan file-nya di-chunk dan di-embed sekali, lalu sebelum tiap task/fase agent dikasih potongan kode yang paling mirip dengan instruksi — jadi dia tidak habis giliran tool cuma buat `grep`/`find` nyari file yang benar. Embedding-nya pakai model lokal (CPU, tanpa API key, tanpa rate limit) lewat `@huggingface/transformers`; kalau paket itu tidak terpasang, RAG cuma jadi no-op, tidak pernah menggagalkan task.

Chunking-nya per-simbol: dipotong di batas fungsi/kelas (heuristik per bahasa), bukan window baris buta — jadi satu potongan itu unit yang utuh. Bahasa yang tidak keparse balik ke window ~60 baris.

Index-nya inkremental (hanya file yang berubah yang di-embed ulang) dan menyegar sendiri: sekali pas project didaftarkan, lalu cek cepat tiap task (langsung skip kalau default branch belum bergerak). `hapus project` ikut menghapus index-nya. `RAG_CROSS_REPO=true` bikin retrieval juga narik beberapa potongan dari project lain yang keregister (ditandai `[project <nama>]`), buat pola lintas-repo. Knob-nya (`RAG_TOP_K`, `RAG_MAX_CONTEXT_CHARS`, `RAG_CHUNK_LINES`, dst) ada di `.env.example`; detail teknis di `ARCHITECTURE.md` ("Konteks kode (RAG)").

## Folder lokal (bukan repo git)

Selain repo GitHub, agent juga bisa kerja langsung di folder lokal mana pun di server tempat `agent-engineer-system` ini jalan — termasuk folder project ini sendiri. Bedanya dengan `tambah project`:

- **`tambah folder <nama> <path-lokal>`** — path absolut, boleh mengandung spasi. Tidak ada clone/branch/PR; agent baca-tulis langsung di folder itu di tempat.
- **Butuh konfirmasi sekali di awal.** Karena ini bukan clone sekali-pakai yang gampang dibuang kalau ada yang salah (beda dengan `workspaces/<nama>` untuk repo git), agent akan tanya izin dulu ("Boleh lanjut? Balas ya/tidak") sebelum folder itu benar-benar terdaftar. Sekali diizinkan, task-task berikutnya di folder itu jalan otonom penuh seperti project git — tidak ditanya lagi setiap kali.
- Kalau folder itu kebetulan repo git juga, agent boleh pakai `git commit` dsb dari dalam task (lewat tool `bash`), tapi itu inisiatifnya sendiri — bukan alur wajib seperti project git biasa.

**Soal keamanan**: tool `read_file`/`write_file`/`edit_file` dibatasi supaya tidak bisa keluar dari folder yang didaftarkan. Tool `bash` dikurung oleh `AGENT_SANDBOX` (lihat "Catatan keamanan") — environment-nya sudah di-scrub, dan di Linux dengan `bubblewrap` cuma folder itu yang bisa ditulis — tapi kalau `bubblewrap` tidak terpasang, command bash tetap jalan dengan akses sebesar user OS yang menjalankan orchestrator. Tetap jangan daftarkan folder yang isinya kamu tidak percaya sepenuhnya untuk diotak-atik.

## Model AI per departemen

Selain satu model AI default, kamu bisa atur model yang berbeda untuk tiap "departemen": **Manajemen Proyek & Produk**, **Tim Pengembangan**, **Tim Desain**, **QA & Testing**, **Infrastruktur & Operasional**, dan **Tim Bisnis & Pendukung**.

**Cara kerjanya, tiap ada instruksi baru:**
1. Agent minta satu AI (model default) nebak departemen mana yang relevan buat instruksi itu, dan urutan kerjanya — kebanyakan instruksi cuma butuh 1-3 departemen, bukan keenamnya.
2. Rencana itu dikirim ke kamu buat dikonfirmasi dulu ("Rencananya gini... Lanjut?") — supaya kalau tebakannya meleset, kamu bisa batalin sebelum AI kepanjangan kerja di arah yang salah.
3. Setelah kamu balas "ya", tiap departemen yang relevan benar-benar dapat sesi kerja sendiri-sendiri secara berurutan (bukan cuma satu sesi yang berpura-pura jadi banyak peran) — pakai model yang sudah kamu tentukan untuk departemen itu (`pakai model <departemen> <nama>`), atau model default kalau belum diatur. Tiap departemen dapat ringkasan hasil kerja departemen sebelumnya sebagai konteks. Cuma departemen terakhir yang commit/merge/push — departemen sebelumnya cukup ubah file, biar history git-nya gak berantakan per-fase.
4. Kalau instruksinya kelihatan gak butuh pemisahan departemen (mis. cuma typo fix kecil), agent bakal usulkan "Satu langkah umum" — ini jalan persis seperti versi lama (satu sesi AI ngerjain semuanya), bukan lewat pipeline multi-fase.

"Model default kalau belum diatur" di poin 3 di atas sebenarnya sudah bukan satu model tunggal buat semua departemen — dari awal, **dev** (dan seluruh bagian yang cuma ngobrol: intro/sapaan/bantuan/chat/klasifikasi) sudah default ke provider yang beda: `dev` ke provider yang model default-nya emang buat coding (`qwen3-coder-plus`/`qwen/qwen3-coder:free`), `manajemen` (dan semua obrolan langsung di luar pipeline) ke provider yang tadinya emang jadi default utama. Jadi sesi ngoding gak ikut menghabiskan kuota model yang lagi kamu ajak ngobrol, dan sebaliknya. Diatur lewat `DEPARTMENT_DEFAULT_PROVIDERS` di `.env` — `pakai model <departemen> <nama>` tetap menang di atas default ini kapan pun kamu mau override.

**Trade-off yang perlu disadari**: makin banyak departemen yang relevan, makin banyak panggilan AI per task (klasifikasi + satu per fase) — jadi lebih lambat dan lebih boros kuota provider gratis dibanding versi satu-langkah. Kalau providernya lagi ketat kuotanya, pertimbangkan set model default ke provider dengan kuota paling longgar, atau assign provider berbeda ke tiap departemen biar bebannya kesebar.

### Checkpoint per-fase (review sebelum lanjut)

Default-nya pipeline jalan otonom penuh — begitu kamu konfirmasi rencana, semua fase jalan berurutan tanpa jeda sampai selesai. Kalau planning-nya lebih dari satu fase, tombol konfirmasinya jadi tiga pilihan: **"Ya, langsung"** (perilaku default), **"Ya, review tiap fase"**, atau **"Tidak, batal"**.

Pilih **"review tiap fase"** kalau kamu mau tau dan approve hasil tiap departemen dulu sebelum lanjut ke fase berikutnya — berguna terutama buat fase manajemen: kalau kamu minta dia bikinin FSD/user story/timeline dan hasilnya belum sesuai, kamu bisa revisi dulu sebelum fase dev/desain kepalang jalan berdasarkan requirement yang salah. Begitu satu fase kelar, agent pause dan kirim ringkasannya + tombol Ya/Tidak:
- **Tap "Ya, lanjut"** — fase berikutnya jalan.
- **Ketik langsung apa yang mau diubah** (gak perlu command khusus, apapun selain "ya"/"tidak" dianggap instruksi revisi) — fase yang sama jalan ulang dengan konteks hasil sebelumnya + revisi kamu, lalu checkpoint lagi. Bisa diulang beberapa kali sampai hasilnya sesuai.
- **Tap "Tidak, batal"** — pipeline berhenti di situ, fase-fase berikutnya gak jalan.

`stop`/`batalkan` tetap langsung mempan meskipun lagi nge-pause di checkpoint. Ini opt-in per-task, bukan setting yang nempel — task selanjutnya balik ke default (langsung) kecuali kamu pilih lagi.

### Pilih model spesifik, bukan cuma provider

Satu provider (mis. Gemini) biasanya punya banyak model (`gemini-3.1-flash-lite`, `gemini-3.5-flash`, dst) — `GEMINI_MODEL` di `.env` cuma nentuin satu default. Buat pilih model tertentu secara spesifik lewat WhatsApp:

1. **`daftar model <provider> <kata kunci>`** — cari model di catalog provider itu, mis. `daftar model gemini flash-lite`. Agent benar-benar **mencoba tiap model** (bukan cuma baca daftar) dan **cuma nampilin yang beneran bisa dipakai sekarang** — model yang ada di catalog tapi error/404/kena limit buat API key kamu otomatis disembunyikan (ini beneran terjadi: `gemini-2.5-flash-lite` misalnya masih muncul di catalog Gemini tapi sudah tidak bisa dipakai API key baru). Maksimal 8 model dicek sekaligus biar gak boros kuota.
2. **`pakai model <provider>/<model>`** atau **`pakai model <departemen> <provider>/<model>`** — pilih model spesifik itu (bukan cuma provider-nya). Sebelum diterapkan, agent coba dulu model itu sekali — kalau ternyata gak bisa dipakai, permintaannya ditolak dengan penjelasan kenapa, bukan diam-diam disimpan lalu gagal pas dipakai beneran.

## Integrasi Figma — lagi nonaktif

Fitur ini (baca desain Figma lewat [MCP server resmi Figma](https://developers.figma.com/docs/figma-mcp-server/)) sudah dibangun lengkap tapi sengaja dinonaktifkan: Figma sendiri yang membatasi scope OAuth `mcp:connect` cuma untuk klien yang sudah mereka approve duluan (dikonfirmasi langsung oleh Figma support di forum mereka), dan gak ada jalur pendaftaran mandiri untuk custom OAuth app. Semua percobaan sejauh ini — PKCE, parameter `resource` (RFC 8707), redirect URI yang benar — tetap kena `Invalid scope: mcp:connect`, karena ini pembatasan Figma di sisi mereka, bukan bug di kode.

Kalau Figma nanti membuka akses ini (atau app kamu spesifik di-approve), kodenya tinggal diaktifkan lagi — lihat komentar di `handleConnectFigmaCommand` (`apps/orchestrator/src/router/handler.ts`).

## Kirim dokumen sebagai lampiran WhatsApp

Selain nulis file ke repo/folder, agent bisa ngirim file itu langsung sebagai lampiran dokumen di chat — bukan cuma diceritain dalam teks. AI yang mutusin kapan pakai ini (tool `send_document`), bukan otomatis buat tiap file yang disentuh — biar gak spam lampiran tiap kali agent nulis banyak file dalam task koding biasa. Dipanggil kalau kamu eksplisit minta dikirim/dilampirkan, atau memang itu tujuan tasknya (mis. "bikinin FSD-nya" → FSD.md-nya ikut dikirim).

Contoh instruksi: `bikinin FSD buat fitur checkout, terus kirimin filenya ke sini`.

Batasan:
- Tipe file yang didukung: `.pdf .doc .docx .ppt .pptx .xls .xlsx .csv .txt .md .zip`. Di luar itu ditolak (default-deny, sama kayak filter tool Figma).
- Maksimal 16MB per file — jauh di bawah limit dokumen WhatsApp (100MB) karena file dikirim base64 lewat panggilan internal, bukan streaming.
- Kalau tipe file gak didukung atau kegedean, agent kasih tau jelas kenapa (bukan error mentah dari API).

## Kirim gambar buat direview/dikerjain

Kirim gambar (screenshot, mockup, error dialog, dsb) langsung dari WhatsApp — agent bakal "liat" isinya dulu lewat AI vision sebelum mulai kerja. Kalau gambarnya dikirim bareng caption (mis. "perbaiki tampilan sesuai screenshot ini"), caption + hasil liatan gambar langsung jadi instruksi, lewat alur konfirmasi rencana yang sama seperti instruksi teks biasa. Kirim tanpa caption juga boleh — agent bakal ceritain apa yang dia liat, terus nanya mau diapain, daripada nebak-nebak sendiri.

Batasan:
- Format yang didukung: JPEG dan PNG saja (batasan bawaan WhatsApp Cloud API untuk pesan tipe gambar — bukan batasan kita).
- Maksimal 5MB per gambar (limit bawaan WhatsApp buat gambar masuk).
- Butuh provider AI yang model-nya bisa vision — dari default `AI_PROVIDER_ORDER=gemini,openrouter,qwen`, cuma Gemini yang vision-capable; model coder default OpenRouter/Qwen gak bisa "lihat" gambar. Kalau semua provider yang aktif gak bisa, agent bilang jelas dan nyaranin ganti model, gak diam-diam nebak.

## Voice note

Kirim voice note WhatsApp — gateway ambil audionya, orchestrator transcribe lewat Gemini, terus perlakuin hasilnya persis kayak kamu ngetik: bisa instruksi task, jawaban konfirmasi ("ya"/"tidak"), command ("status", "pakai <project>"), atau ngobrol biasa. Sebelum lanjut, agent balas `Oke, aku denger: "<transkrip>"` biar kalau salah dengar kamu bisa langsung ralat.

Butuh provider AI yang model-nya bisa audio (dari default cuma Gemini) — kalau yang aktif nggak bisa, agent bilang dan minta kamu ketik aja. Maks 16MB per voice note (limit WhatsApp).

**Balasan voice** (opt-in, `VOICE_REPLY_ENABLED`): kalau nyala, voice note dibales voice note juga — balasan substantif pertama disintesis jadi MP3 (Gemini TTS → PCM → MP3 pakai encoder pure-JS, gak butuh ffmpeg) dan dikirim balik. Progress message task yang panjang nggak ikut dibacain — cuma yang pertama. Satu panggilan TTS per balasan yang divoice-in; model TTS-nya punya kuota free-tier sendiri yang bisa ketat, makanya opt-in. Gagal sintesis / gak ada provider TTS → balasan teksnya tetap kekirim, cuma nggak ada versi suaranya.

## Task terjadwal

`jadwalkan tiap <kapan>: <instruksi>` bikin task yang jalan sendiri berulang di project aktif. Contoh:

```
jadwalkan tiap senin jam 9: update dependencies lalu jalanin test
jadwalkan tiap hari jam 7 pagi: cek lint, commit kalau bersih
jadwalkan tiap tanggal 1: bump versi patch
jadwalkan tiap 6 jam: sync data dari staging
```

Bentuk "kapan" yang didukung: `tiap hari [jam H]`, `tiap <senin..minggu> [jam H]`, `tiap tanggal <1-31> [jam H]`, `tiap jam`, `tiap <N> jam` (N ∈ 1/2/3/4/6/8/12). Jam boleh `H`, `H:MM`, atau ditambahi `pagi/siang/sore/malam`; kalau dihilangkan default jam 08:00. Semua waktu WIB.

Pas waktunya tiba, agent nge-classify departemen ulang (biar ikut kondisi kode terkini) terus langsung jalan — tanpa nunggu konfirmasi, karena kamu udah nyetujui waktu bikin jadwalnya. `daftar jadwal` buat lihat semua (bernomor), `hapus jadwal <nomor>` buat batalin. Hapus project juga otomatis ngehapus jadwalnya.

## Ringkasan harian

Mati secara default (`DAILY_DIGEST_ENABLED`). Kalau nyala, sekali sehari jam `DAILY_DIGEST_HOUR` (WIB, default 7) kamu (nomor `OWNER_WHATSAPP_NUMBER`) dikirimin ringkasan tanpa diminta: task 24 jam terakhir di semua project (yang gagal disebut satu-satu beserta alasannya), jadwal yang bakal jalan hari ini, dan hitungan panggilan AI kemarin per key/model. Loop 5 menitan yang nembak pas ketemu jam target di hari baru; kalau gagal kirim, gak diulang-ulang sejam itu.

## Ngobrol santai + memori

Pesan yang bukan command dan bukan instruksi kerjaan (pertanyaan, komentar, basa-basi) gak lagi otomatis dipaksa jadi task koding — agent ngenalin dulu ini ngobrol biasa atau bukan, terus jawab kayak asisten AI beneran, bukan nyoba nebak-nebak departemen mana yang ngerjain. Balasannya pakai konteks obrolan terakhir (beberapa pesan terakhir, bukan seluruh riwayat) plus hal-hal yang udah dipelajari soal kamu dari obrolan sebelumnya — dan itu kesimpen permanen lintas sesi, bukan cuma selama chat masih kebuka.

- Ketik *lihat memori* buat liat semua yang udah aku inget soal kamu, atau *lupain semua* buat hapus itu semua (dikonfirmasi dulu, gak bisa dibalikin lagi).
- Fitur ini nambah satu panggilan AI ekstra per pesan ngobrol biasa (buat nentuin ini ngobrol atau kerjaan) — masih murah di rantai provider free-tier yang udah dipakai, tapi disebut di sini biar gak kaget kalau kerasa.
- Pesan yang panjangnya lebih dari ~40 kata langsung dianggap task seperti biasa, gak dicek dulu ini ngobrol atau bukan — biar gak nambah biaya buat instruksi kerjaan yang emang udah jelas panjang.

## Catatan keamanan

- Hanya nomor di `ALLOWED_SENDERS` yang perintahnya diproses.
- Setiap command bash/git yang dijalankan agent dicatat di tabel `audit_log`.
- Kirim `stop`/`batalkan` kapan saja untuk menghentikan task yang sedang berjalan — ini jaring pengaman minimal karena agent berjalan otonom penuh tanpa approval per langkah.
- Kalau server restart di tengah task, task yang belum selesai otomatis dijalankan ulang dari awal saat orchestrator hidup lagi (aman: belum ada yang di-merge/push sebelum fase terakhir). Task yang gagal terus setelah 2 kali percobaan restart dilepas dengan pemberitahuan, biar nggak looping.
- `.env` menyimpan kredensial sensitif — jangan commit ke git (`.gitignore` sudah menghandle ini).
- **Sandbox `bash`** (`AGENT_SANDBOX`, default `auto`): command yang dijalankan agent lewat `bash` cuma dapat sebagian kecil environment — kunci vendor (`GEMINI_API_KEY`, dll), `INTERNAL_SHARED_SECRET`, token Meta nggak ikut, jadi nggak bisa dibocorkan lewat `env`/`printenv`. Di Linux dengan `bubblewrap` terpasang, ditambah pengurungan filesystem: cuma workspace task itu yang bisa ditulis, `.env` dan database aplikasi ini nggak kebaca sama sekali. Pasang `bubblewrap` di image Docker biar lapis ini aktif; `AGENT_SANDBOX=off` balik ke perilaku lama.
- **Secret scan** (`SECRET_SCAN_ENABLED`, default on): agent nggak bisa `git commit` file yang mengandung pola kredensial jelas (GitHub PAT, AWS key, private key, dll) — commit-nya dibatalkan dan agent harus membereskan dulu. Repo yang baru didaftarkan juga discan sekali; kalau sudah terlanjur ada kredensial ke-commit, kamu dapat peringatan buat me-rotate-nya.

## Pengembangan lokal

```bash
npm install
cp .env.example .env   # isi minimal 1 AI provider (GEMINI_API_KEY paling gampang), GITHUB_TOKEN, INTERNAL_SHARED_SECRET, dst.
npm run dev:orchestrator   # terminal 1
npm run dev:gateway        # terminal 2
```

`npm run build` + `npm test` jalan otomatis di GitHub Actions (`.github/workflows/ci.yml`) tiap push ke `main` dan tiap PR.

Untuk testing webhook lokal tanpa domain publik, gunakan tunnel (ngrok/cloudflared) ke port `whatsapp-gateway` (default 3000) — atau jalankan `./scripts/dev-tunnel.sh`, yang menyalakan kedua service + tunnel ngrok, **dan otomatis memperbaiki webhook subscription-nya juga** (lihat Troubleshooting di bawah untuk kenapa ini perlu). Butuh ngrok sudah ter-install & `ngrok config add-authtoken` sudah dijalankan sekali, plus `META_APP_ID`/`META_WABA_ID` sudah diisi di `.env`. Ctrl+C untuk stop semuanya.

Kalau kamu jalankan orchestrator/gateway manual di 2 terminal terpisah (bukan lewat script), dan ngrok-nya juga jalan manual/terpisah, jalankan `./scripts/fix-whatsapp-webhook.sh` sendiri setiap kali URL ngrok berubah (script ini auto-detect URL dari ngrok API di `:4040`, atau kasih URL-nya sebagai argumen).

## Troubleshooting: webhook berhenti terima pesan

Gejala: semua kelihatan benar (Callback URL ke-verify sukses, health check server OK, kredensial valid), tapi kirim pesan WhatsApp tidak pernah memicu apa-apa di log orchestrator/gateway.

**Penyebab #1 — field `messages` diam-diam ke-reset.** Setiap kali Callback URL webhook berubah (paling sering: setiap restart `ngrok` gratis, karena URL-nya acak tiap sesi), Meta sering mereset daftar field yang di-subscribe balik ke default minimal — field `messages` (yang paling penting, untuk menerima pesan masuk) hilang dari daftar, meskipun di UI dashboard terlihat seperti sudah tercentang/aktif. Cek langsung lewat API mana yang benar:
```bash
curl "https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_APP_ID}/subscriptions?access_token=${META_APP_ID}|${META_APP_SECRET}"
```
Kalau `messages` tidak ada di `fields`, itu penyebabnya.

**Penyebab #2 — WABA belum "subscribe" ke App ini.** Field subscription di App saja tidak cukup; WhatsApp Business Account (WABA) juga harus secara eksplisit menghubungkan App sebagai penerima webhook-nya lewat endpoint terpisah. Tanpa ini, WABA bisa saja masih terhubung ke app lain (termasuk app demo bawaan Meta sendiri) alih-alih ke app kita — pesan test dari Meta ("Jasper's Market", dll) tetap muncul di WhatsApp kamu, tapi itu tidak lewat webhook kita sama sekali. Cek:
```bash
curl "https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_WABA_ID}/subscribed_apps" -H "Authorization: Bearer ${META_ACCESS_TOKEN}"
```
App kita (`META_APP_ID`) harus ada di daftar `data`.

**Perbaikan untuk keduanya sekaligus** (aman dijalankan berkali-kali):
```bash
./scripts/fix-whatsapp-webhook.sh                              # auto-detect URL ngrok
./scripts/fix-whatsapp-webhook.sh https://domain-produksi.com  # atau kasih URL eksplisit (VPS/produksi)
```
`./scripts/dev-tunnel.sh` sudah menjalankan ini otomatis setiap start, jadi kalau kamu selalu pakai script itu untuk dev lokal, harusnya tidak akan ketemu masalah ini lagi. Untuk deploy VPS/produksi (domain tetap, jadi tidak ada masalah URL berubah-ubah), tetap jalankan sekali secara manual setelah setup webhook pertama kali di step 3 sebelumnya, sebagai pengaman kalau-kalau subscribe lewat UI-nya juga tidak benar-benar tersimpan.

## Fase lanjutan (belum diimplementasikan)

- Sandbox Docker (atau microVM) per-task untuk isolasi eksekusi yang lebih kuat dari `bubblewrap`.
- Deploy ke selain Vercel (Render/Netlify/Fly) — sekarang cuma Vercel (lihat "Deploy ke Vercel").

## Lisensi

MIT — lihat [`LICENSE`](LICENSE).
