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
tambah folder <nama> <path>           → daftarkan folder lokal di server (bukan repo git)
pakai <nama>                          → ganti project aktif
daftar model                          → cek AI provider + model per departemen, masih bisa dipakai atau tidak
pakai model <nama>                    → model AI default (dipakai departemen yang belum punya model sendiri)
pakai model <departemen> <nama>       → model AI khusus satu departemen (manajemen/dev/desain/qa/infra/bisnis)
status                                → lihat task yang sedang berjalan (termasuk fase yang lagi jalan)
stop / batalkan                       → hentikan task yang sedang berjalan
hubungkan figma                       → sambungkan akun Figma (sekali saja) — lihat "Integrasi Figma" di bawah
bantuan                               → tampilkan daftar perintah
```

## Kebijakan merge per-project

Default: agent commit langsung ke branch utama repo (`auto_merge = 'direct'`) — sesuai preferensi otonomi penuh. Untuk mengubah suatu project supaya lewat PR dulu, update kolom `auto_merge` jadi `'pr'` di tabel `projects` (`data/orchestrator.sqlite`).

## Disiplin kode minimal (default, hemat token)

Setiap task — di semua mode (git, folder lokal, tiap fase pipeline) — otomatis dapat instruksi "lazy senior developer" di system prompt-nya (diadaptasi dari [ponytail](https://github.com/dietrichgebert/ponytail)): sebelum nulis kode, agent wajib naik satu-satu "tangga" ini dan berhenti di anak tangga pertama yang cocok — apa ini emang perlu ada (YAGNI) → udah ada di codebase → stdlib bisa → fitur native platform → dependency yang udah terpasang → bisa satu baris → baru terakhir, tulis kode seminimal mungkin yang benar. Ini gak mengorbankan kebenaran — validasi input, penanganan error, dan requirement eksplisit tetap wajib; "minimal" artinya solusi terkecil yang *benar*, bukan asal potong. Diff lebih kecil = lebih sedikit token dibaca/ditulis/direview, dan lebih sedikit kode yang harus dirawat ke depannya. Lihat `apps/orchestrator/src/agent/systemPrompt.ts` (`SHARED_MINIMAL_CODE_RULES`) kalau mau ubah teksnya.

## Folder lokal (bukan repo git)

Selain repo GitHub, agent juga bisa kerja langsung di folder lokal mana pun di server tempat `agent-engineer-system` ini jalan — termasuk folder project ini sendiri. Bedanya dengan `tambah project`:

- **`tambah folder <nama> <path-lokal>`** — path absolut, boleh mengandung spasi. Tidak ada clone/branch/PR; agent baca-tulis langsung di folder itu di tempat.
- **Butuh konfirmasi sekali di awal.** Karena ini bukan clone sekali-pakai yang gampang dibuang kalau ada yang salah (beda dengan `workspaces/<nama>` untuk repo git), agent akan tanya izin dulu ("Boleh lanjut? Balas ya/tidak") sebelum folder itu benar-benar terdaftar. Sekali diizinkan, task-task berikutnya di folder itu jalan otonom penuh seperti project git — tidak ditanya lagi setiap kali.
- Kalau folder itu kebetulan repo git juga, agent boleh pakai `git commit` dsb dari dalam task (lewat tool `bash`), tapi itu inisiatifnya sendiri — bukan alur wajib seperti project git biasa.

**Soal keamanan**: tool `read_file`/`write_file`/`edit_file` dibatasi supaya tidak bisa keluar dari folder yang didaftarkan, tapi tool `bash` **tidak** dibatasi sejauh itu — command apa pun yang dijalankan agent lewat `bash` punya akses sebesar user OS yang menjalankan proses orchestrator. Jangan daftarkan folder yang isinya kamu tidak percaya sepenuhnya untuk diotak-atik.

## Model AI per departemen

Selain satu model AI default, kamu bisa atur model yang berbeda untuk tiap "departemen": **Manajemen Proyek & Produk**, **Tim Pengembangan**, **Tim Desain**, **QA & Testing**, **Infrastruktur & Operasional**, dan **Tim Bisnis & Pendukung**.

**Cara kerjanya, tiap ada instruksi baru:**
1. Agent minta satu AI (model default) nebak departemen mana yang relevan buat instruksi itu, dan urutan kerjanya — kebanyakan instruksi cuma butuh 1-3 departemen, bukan keenamnya.
2. Rencana itu dikirim ke kamu buat dikonfirmasi dulu ("Rencananya gini... Lanjut?") — supaya kalau tebakannya meleset, kamu bisa batalin sebelum AI kepanjangan kerja di arah yang salah.
3. Setelah kamu balas "ya", tiap departemen yang relevan benar-benar dapat sesi kerja sendiri-sendiri secara berurutan (bukan cuma satu sesi yang berpura-pura jadi banyak peran) — pakai model yang sudah kamu tentukan untuk departemen itu (`pakai model <departemen> <nama>`), atau model default kalau belum diatur. Tiap departemen dapat ringkasan hasil kerja departemen sebelumnya sebagai konteks. Cuma departemen terakhir yang commit/merge/push — departemen sebelumnya cukup ubah file, biar history git-nya gak berantakan per-fase.
4. Kalau instruksinya kelihatan gak butuh pemisahan departemen (mis. cuma typo fix kecil), agent bakal usulkan "Satu langkah umum" — ini jalan persis seperti versi lama (satu sesi AI ngerjain semuanya), bukan lewat pipeline multi-fase.

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

## Integrasi Figma (read-only, lewat MCP)

Agent bisa "lihat" desain Figma — baca layer, style, variabel, generate kode dari frame, export gambar — lewat [MCP server resmi Figma](https://developers.figma.com/docs/figma-mcp-server/) (`https://mcp.figma.com/mcp`, versi remote, gak butuh Figma desktop app jalan di server). Cuma baca: agent sengaja gak pernah manggil tool Figma yang bisa mengubah/menulis/comment, walaupun server-nya sendiri punya tool semacam itu (masih beta) — kita filter sendiri, cuma tool yang namanya jelas-jelas "get_..." yang diekspos ke AI.

**Setup sekali (di server):**
1. Daftarkan OAuth app di [Figma Developer Console](https://www.figma.com/developers/apps) dengan scope `mcp:connect`.
2. Set redirect URI-nya ke `https://<domain-kamu>/figma/oauth/callback` (harus persis sama di kedua tempat — Figma dev console dan `.env`).
3. Isi `FIGMA_MCP_CLIENT_ID`, `FIGMA_MCP_CLIENT_SECRET` (kalau ada), `FIGMA_OAUTH_REDIRECT_URI` di `.env`.

**Cara pakai (dari WhatsApp):**
1. Ketik `hubungkan figma` — sekali saja. Agent kirim link, buka di browser, izinkan aksesnya. Token disimpan dan di-refresh otomatis sesudahnya, gak perlu diulang tiap task.
2. Tempel link Figma langsung di instruksi kamu, mis.:
   ```
   bikin komponen React dari desain ini: https://figma.com/design/abc123/My-File?node-id=12-34
   ```
   Agent otomatis mendeteksi link itu dan nyambung ke Figma buat instruksi tersebut — gak ada command pendaftaran project Figma terpisah.

Kalau kamu tempel link Figma sebelum pernah `hubungkan figma`, agent bakal bilang jelas ("belum kesambung, ketik hubungkan figma dulu") daripada gagal diam-diam.

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

## Ngobrol santai + memori

Pesan yang bukan command dan bukan instruksi kerjaan (pertanyaan, komentar, basa-basi) gak lagi otomatis dipaksa jadi task koding — agent ngenalin dulu ini ngobrol biasa atau bukan, terus jawab kayak asisten AI beneran, bukan nyoba nebak-nebak departemen mana yang ngerjain. Balasannya pakai konteks obrolan terakhir (beberapa pesan terakhir, bukan seluruh riwayat) plus hal-hal yang udah dipelajari soal kamu dari obrolan sebelumnya — dan itu kesimpen permanen lintas sesi, bukan cuma selama chat masih kebuka.

- Ketik *lihat memori* buat liat semua yang udah aku inget soal kamu, atau *lupain semua* buat hapus itu semua (dikonfirmasi dulu, gak bisa dibalikin lagi).
- Fitur ini nambah satu panggilan AI ekstra per pesan ngobrol biasa (buat nentuin ini ngobrol atau kerjaan) — masih murah di rantai provider free-tier yang udah dipakai, tapi disebut di sini biar gak kaget kalau kerasa.
- Pesan yang panjangnya lebih dari ~40 kata langsung dianggap task seperti biasa, gak dicek dulu ini ngobrol atau bukan — biar gak nambah biaya buat instruksi kerjaan yang emang udah jelas panjang.

## Catatan keamanan

- Hanya nomor di `ALLOWED_SENDERS` yang perintahnya diproses.
- Setiap command bash/git yang dijalankan agent dicatat di tabel `audit_log`.
- Kirim `stop`/`batalkan` kapan saja untuk menghentikan task yang sedang berjalan — ini jaring pengaman minimal karena agent berjalan otonom penuh tanpa approval per langkah.
- `.env` menyimpan kredensial sensitif — jangan commit ke git (`.gitignore` sudah menghandle ini).

## Pengembangan lokal

```bash
npm install
cp .env.example .env   # isi minimal 1 AI provider (GEMINI_API_KEY paling gampang), GITHUB_TOKEN, INTERNAL_SHARED_SECRET, dst.
npm run dev:orchestrator   # terminal 1
npm run dev:gateway        # terminal 2
```

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

- Deploy otomatis aplikasi yang dibuat agent (Vercel/Render/DigitalOcean API) supaya langsung dapat URL live.
- Role PM/BA/QA/Dev sebagai subagent terpisah, bukan satu system prompt.
- Sandbox Docker per-task untuk isolasi eksekusi.
- Dukungan lampiran WhatsApp berupa voice note (gambar sudah didukung, lihat "Kirim gambar buat direview/dikerjain" di atas).
