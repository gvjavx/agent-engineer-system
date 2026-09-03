# Arsitektur teknis — Mas ADE

Dokumen ini menjelaskan alur kerja internal sistem, bukan cara pakainya (itu ada di `README.md`). Ditulis untuk siapa pun yang mau nambah fitur atau debug perilaku bot ini.

## Peta besar

```
WhatsApp user
   │ pesan/tombol/gambar
   ▼
Meta Cloud API ──webhook──▶ apps/whatsapp-gateway
                                  │ verifikasi HMAC signature, filter ALLOWED_SENDERS,
                                  │ download+validasi gambar kalau ada
                                  ▼
                            POST /inbound ──▶ apps/orchestrator
                                                  │ filter ALLOWED_SENDERS lagi (defense in depth)
                                                  │ router/handler.ts: handleInboundMessage
                                                  ▼
                                          dispatch chain (lihat bagian bawah)
                                                  │
                                    ┌─────────────┼──────────────────┐
                                    ▼             ▼                  ▼
                              command          chat biasa      task koding
                              deterministik    (chatAssistant)  (classifier → pipeline →
                              atau AI-classify                   agent loop → tools →
                                                                  git/GitHub)
```

Dua proses Node terpisah (`apps/whatsapp-gateway`, `apps/orchestrator`), komunikasi lewat HTTP internal dengan header `X-Internal-Secret`. Gateway itu satu-satunya yang punya endpoint publik beneran (`POST /webhook` dari Meta, `GET /figma/oauth/callback` dari browser user); orchestrator cuma nerima dari gateway.

Tidak pakai Claude Agent SDK — tool-calling loop custom di `agent/loop.ts`, provider-agnostic lewat interface `Provider` (`agent/types.ts`) supaya bisa jalan di atas Gemini/OpenRouter/Qwen/provider OpenAI-compatible lain secara bergantian (fallback chain, lihat bagian Provider AI).

## Alur pesan masuk, langkah demi langkah

1. **Meta → gateway**: `POST /webhook`. Body di-parse dengan `express.json({verify: ...})` supaya raw bytes-nya kesimpen buat verifikasi signature (`verifySignature`, HMAC-SHA256 pakai `META_APP_SECRET`, dibanding pakai `crypto.timingSafeEqual`). Gagal verifikasi → 401. Gateway **selalu balas 200 duluan** sebelum mroses, soalnya Meta retry agresif kalau lambat/error.
2. **Ekstraksi pesan** (`whatsapp.ts` → `extractInboundMessages`): satu payload bisa berisi banyak pesan. Tiga tipe ditangani — `text` (langsung), `interactive` (tombol/list yang di-tap, `.id`-nya diperlakukan persis seperti user ngetik itu sendiri — jadi command-parsing di orchestrator nggak perlu tahu soal tombol sama sekali), `image` (cuma bawa `imageId` + `imageMimeType`, caption masuk ke field `text` yang sama seperti tombol tadi — bytes-nya belum ke-download di tahap ini).
3. **Filter pengirim**: `ALLOWED_SENDERS` dicek di gateway (drop diam-diam kalau nggak cocok) — ini gerbang pertama.
4. **Gambar (kalau ada)**: divalidasi mime type dari metadata webhook dulu (gagal cepat, belum keluar network call), baru `downloadMedia` (dua panggilan Graph API berurutan: resolve id→URL sementara yang cuma hidup 5 menit, lalu fetch bytes-nya), lalu divalidasi ulang mime type dari Content-Type respons yang sebenarnya + ukuran (maks 5MB, `imageGuard.ts`). Gagal di titik mana pun → user dikasih tahu, pesan itu di-skip (tidak lanjut ke orchestrator).
5. **Forward** (`orchestratorClient.ts`): `POST {ORCHESTRATOR_URL}/inbound` dengan header `X-Internal-Secret`, body `{from, text, waMessageId, timestamp, image?}`.
6. **Orchestrator terima** (`index.ts`, `POST /inbound`, body limit 8MB buat nampung gambar base64): cek secret, cek `ALLOWED_SENDERS` **lagi** (defense in depth — endpoint ini nggak boleh percaya buta ke pemanggil yang cuma modal tahu secret-nya), balas 202 langsung, baru proses `handleInboundMessage` secara async.
7. **Dispatch** — masuk ke `router/handler.ts`, dijelaskan detail di bagian berikut.

## Dispatch chain (`handleInboundMessage`)

Ini fungsi paling sentral di seluruh sistem. Urutan pengecekan penting — makin ke atas makin murah/deterministik, makin ke bawah makin "AI yang mutusin", command spesifik selalu menang lawan tebakan generik.

```
0. Ada voice note?  ──▶ transcribe ke teks dulu (transcribeInboundVoiceNote),
   sisanya jalan persis kayak pesan teks biasa
1. Ada pending bash-approval (in-memory)?  ──▶ handlePendingBashApproval
2. Ada pending checkpoint (in-memory)?     ──▶ handlePendingCheckpoint
3. Ada pending_action tersimpan di DB?     ──▶ handlePendingConfirmation
4. Ada gambar?                             ──▶ handleImageMessage
5. Cocok salah satu command deterministik  ──▶ handler masing-masing
   (intro/greeting/help/daftar project/daftar model/status/stop/
   review PR <nomor>/jadwalkan .../daftar jadwal/hapus jadwal <n>/
   hubungkan figma/lihat memori/lupain semua/tambah-hapus project-folder,
   termasuk versi "diketik tanpa argumen" yang start wizard/picker)
6. Cocok sentinel tombol menu "bantuan"?   ──▶ wizard/picker terkait
7. AI: paraphrase dari salah satu command  ──▶ tryHandleSemanticCommand
   di atas? (classifyCommandIntent)
8. AI: ini ngobrol biasa atau task koding? ──▶ tryHandleConversational
   (classifyMessageKind)
9. Default: anggap task koding             ──▶ handleFreeTextInstruction
```

Tiga pending-state handler (1–3) dicek **sebelum** apa pun lain, termasuk sebelum gambar — supaya konfirmasi yang lagi nunggu jawaban nggak ke-timpa diam-diam. Urutan 1→2→3 dipilih karena bash-approval & checkpoint itu in-memory (terikat task yang lagi jalan di proses ini), sedangkan pending_action itu persisten di DB (bertahan lintas restart, dipakai buat wizard multi-langkah).

**Kenapa command deterministik (5–6) didahulukan dari AI classifier (7–8)**: command yang persis match nggak boleh digantungkan ke tebakan model — command dengan argumen (`tambah project <alias> <url>`, dst) di-parse regex; command tanpa argumen (`bantuan`, `status`, dst) di-cek exact-phrase dulu (`router/parse.ts`, Set-based, case-insensitive) sebelum jatuh ke classifier buat nangkep parafrase ("gimana caranya pake ini" → `bantuan`).

**Kasus command yang argumennya ketinggalan** (`hapus project` tanpa nama, `tambah project` tanpa alias/url): ini bug nyata yang udah kejadian — kalau nggak ditangkep di sini, jatuh ke classifier lalu ke task pipeline, dan AI-nya salah baca "hapus project" sebagai instruksi **membangun fitur penghapusan project di dalam kode**, bukan perintah admin ke bot itu sendiri. Makanya ada matcher `isBareDeleteProjectCommand`/`isBareAddProjectCommand`/`isBareAddFolderCommand` yang nangkep persis frasa itu tanpa argumen dan langsung start wizard/picker yang sesuai, sebelum sempat nyampe ke classifier mana pun.

**Dua AI classifier terakhir (7–8) punya gate biaya yang sama**: `isPlausibleShortCommand(trimmed, 40)` — pesan kosong, mengandung URL, atau lebih dari 40 kata, langsung skip (nggak keluar biaya panggilan AI). Batas ini pernah 12 kata dan kegedean-sempit — pertanyaan wajar macam "jika saya meminta bantuan untuk bikin aplikasi dari awal apa yang akan kamu lakukan" (14 kata) nggak pernah nyampe ke classifier "explain", langsung dieksekusi sebagai task sungguhan. Dinaikin ke 40 buat kedua classifier.

## `pending_action` — state machine wizard & konfirmasi

Disimpen sebagai JSON di kolom `conversation_state.pending_action` (per nomor WhatsApp), union tipe di `handler.ts`:

| Tipe | Buat apa |
|---|---|
| `guided_git_project` | Wizard "Tambah project (GitHub)" — tanya alias, lalu URL repo, baru daftarin. |
| `guided_folder` | Wizard "Tambah folder lokal" — tanya alias, lalu path absolut, transisi ke `confirm_add_folder`. |
| `confirm_add_folder` | Konfirmasi ya/tidak sebelum daftarin folder lokal (peringatan: bot dapet akses baca/tulis penuh ke folder itu). |
| `confirm_delete_project` | Konfirmasi ya/tidak sebelum unregister project (nggak nyentuh disk). |
| `confirm_pipeline` | Konfirmasi rencana task (daftar fase departemen) sebelum dieksekusi. |
| `confirm_multi_pipeline` | Sama, tapi buat "di a, b: ..." — satu rencana, dieksekusi jadi task terpisah per repo. |
| `confirm_clear_memory` | Konfirmasi ya/tidak sebelum menghapus semua memori soal user itu. |
| `confirm_ci_fix` | Konfirmasi ya/tidak buat nge-garap kegagalan CI yang baru kedeteksi (bawa log kegagalannya). |

Dua state lain — persetujuan bash berbahaya dan checkpoint antar-fase pipeline — **bukan** bagian union ini; keduanya in-memory, per-`taskId`, hidup selama proses orchestrator jalan dan task itu masih aktif (`agent/bashApproval.ts`, `agent/checkpoint.ts`, keduanya pola registry `Map<taskId, resolver>` yang sama).

**Jalan keluar dari wizard yang "kejebak"** (`looksLikeAnotherCommand`, dipanggil di awal `handlePendingConfirmation` dan `handlePendingBashApproval`): kalau pesan yang masuk ternyata jelas-jelas command lain yang valid (misal ngetik "halo" pas lagi ditanya link GitHub), pending state dibatalin dan pesan itu lanjut diproses sebagai command aslinya — bukan dipaksa jadi jawaban buat pertanyaan yang lagi nunggu. `handlePendingCheckpoint` sengaja **tidak** pakai jalan keluar ini — di situ, apa pun selain ya/tidak memang sengaja dianggap instruksi revisi, itu desain yang disengaja.

## Provider AI — fallback chain

`agent/runner.ts`:
- `AI_PROVIDER_ORDER` (env, default `gemini,openrouter,qwen`) → tiap nama di-expand jadi satu `Provider` per API key yang dikonfigurasi buat nama itu (`GEMINI_API_KEY=key1,key2` → 2 provider instance terpisah). Hasilnya satu array panjang, urutan provider lalu urutan key.
- `preferred_provider` (diset lewat "pakai model semua/\<departemen\> \<nama\>") memindahkan **seluruh grup key** provider itu ke depan array, tanpa mempersempit provider lain yang tetap ada di belakang sebagai fallback.
- Kalau satu provider/key gagal atau kena rate limit di tengah `agent/loop.ts`, loop otomatis lanjut ke entry berikutnya dalam array yang sama — **tanpa mengulang task dari awal**, cuma retry giliran itu dengan provider baru.
- **Cooldown pasca-429** (`agent/providerCooldown.ts`): tiap instance punya `id` = `nama@model#<hash8 API key>`. Pas dapet 429, `loop.ts` panggil `markRateLimited(id)` — instance itu di-park ~60 detik. `buildProviders` dibangun ulang tiap pesan dan pass terakhirnya `deprioritizeCooledDown` mindahin instance yang lagi park ke belakang array (urutan lain tetap), jadi `[0]` dan rantai fallback dua-duanya lompatin key/model yang lagi abis kuotanya tanpa nunggu retry-delay dulu. Bukan block keras — kalau semua opsi lain juga mati, instance yang lagi cooldown tetap dicoba di urutan paling belakang.

Tiap provider (`providers/gemini.ts`, `providers/openAiCompatible.ts`) implement interface `Provider` yang sama (`chat(messages, tools, signal)`, opsional `describeImage(...)` dan `transcribeAudio(...)`) — kode di atasnya (loop, classifier, chat assistant) nggak pernah tahu lagi vendor mana yang lagi dipakai. Cuma Gemini yang implement `describeImage`/`transcribeAudio`; `agent/imageDescription.ts` & `agent/audioTranscription.ts` nyisir daftar provider dan nge-skip yang nggak punya.

**Voice note**: gateway nge-detect message `type: "audio"`, download media-nya (`downloadMedia`, sama kayak gambar), cek mime (`audioGuard.ts` — OGG/Opus dll, param codec di-strip) + ukuran (≤16MB), forward ke `/inbound` sebagai `audio: {mimeType, base64Data}` (limit body `/inbound` dinaikin ke 25MB buat nampung base64-nya). Di orchestrator, `handleInboundMessage` nransikrip lewat `transcribeVoiceNote` (Gemini, inline audio part — bentuk yang sama persis kayak vision) **sebelum** apa pun lain, kirim balik `Oke, aku denger: "..."` biar salah-dengar ketahuan, terus teksnya jalan lewat jalur normal (pending-state, command, task) seolah diketik. Gagal transkrip / provider nggak support → dikasih tau, disuruh ketik aja.

**Balasan voice** (opt-in, `VOICE_REPLY_ENABLED`): abis kirim `Oke, aku denger: "..."`, `voiceReplyTarget` di-`arm` ke nomor itu. `whatsappClient.ts`'s `sendWhatsApp` manggil hook opsional (`setVoiceReplyHook`, didaftarin `handler.ts`) tiap kirim; hook-nya cocokin `to` ke `voiceReplyTarget`, skip teks < 12 char (biar yang divoice-in bukan "Sip."), disarm, terus `synthesizeReply` (`agent/voiceReply.ts`): `stripForSpeech` (buang code/link/markdown, potong 600 char) → provider pertama yang punya `synthesizeSpeech` (`providers/gemini.ts`, model `GEMINI_TTS_MODEL`, `responseModalities:["AUDIO"]`) balikin PCM16 → `pcm16ToMp3` (`@breezystack/lamejs`, pure-JS, gak butuh ffmpeg) → `sendWhatsAppAudio` → gateway `/send-audio` → `uploadMedia` + `type:"audio"`. Best-effort di tiap langkah: gagal apa pun = cuma nggak ada versi suara. `voiceReplyTarget` di-clear di awal tiap `handleInboundMessage` biar arm basi nggak bocor ke pesan ketikan berikutnya.

## Empat klasifier AI satu-tembakan

Semua pakai pola yang sama: satu prompt, satu pesan `role:"user"`, minta jawaban satu baris format ketat, di-parse baris-per-baris (toleran kalau modelnya nggak persis ngikutin format), gagal (exception/parse miss/respons non-teks) selalu jatuh ke default yang aman — nggak pernah nebak ke arah yang lebih berisiko.

| Classifier | Mutusin | Default kalau gagal |
|---|---|---|
| `classifyCommandIntent` | Parafrase dari 9 command tetap, atau `none` | `none` |
| `classifyMessageKind` | `task` vs `chat` | `task` — ambigu selalu dianggap task sungguhan, nggak pernah diam-diam dianggap obrolan |
| `classifyConfirmationIntent` | `yes`/`no`/`unclear` buat jawaban konfirmasi | `unclear` — nggak pernah nebak jadi "yes" |
| `classifyDepartments` | Daftar fase departemen buat task koding | Satu fase `semua` (catch-all) |
| `checkNeedsClarification` | Instruksi task terlalu ngambang (nol info produk) → satu pertanyaan | `undefined` (fail-open) — nggak pernah nahan task gara-gara classifier hiccup |

Kalau `CHAT_LOCAL_LLM` nyala, keempatnya lewat `runClassifier` (`agent/localClassifier.ts`): model lokal (`generateStructuredLocal`) dapet giliran pertama, output-nya dipakai **cuma kalau parser-nya nerima** — kalau nggak, jatuh ke vendor persis kayak sebelumnya. Karena tiap parser fail closed ke arah aman, jawaban lokal yang ngaco nggak pernah nyasar ke kelas yang salah, cuma balik ngeluarin biaya panggilan vendor yang tadinya emang bakal keluar. Trade-off-nya latensi CPU: sekali classify lokal beberapa detik vs ~1-2 detik flash-lite.

## Eksekusi task koding

1. `handleFreeTextInstruction`: pastikan ada project aktif (kalau cuma satu project terdaftar, otomatis dipilih; kalau lebih, tanya lewat picker). Panggil `classifyDepartments` buat dapetin daftar fase, tunjukin rencananya, simpen sebagai `pending_action: confirm_pipeline`, tunggu konfirmasi.
2. User konfirmasi (`ya` = jalan lurus, `ya, checkpoint` = review tiap fase, `tidak`/nggak jelas = batal) → `executeTask` → baris `tasks` dibikin (status `queued`, plus `phases_json` + `checkpoints` biar bisa dipulihin) → `queue/taskQueue.enqueueProjectTask`.
3. **Antrian**: serial per-project (task buat project yang sama nunggu task sebelumnya kelar dulu, supaya nggak ada dua sesi agent nulis ke workspace git yang sama bersamaan), paralel lintas-project tapi dibatasi `config.maxConcurrentTasks` (default 3, `MAX_CONCURRENT_TASKS`) — slot pool global yang cuma dipegang selama `run()` beneran jalan, bukan selama task nunggu giliran di chain project-nya. Task ditandai "active" sebelum nunggu slot, jadi `status`/`stop` tetep lihat dia; `stop` pas lagi nunggu slot = `run()` mulai dengan signal udah aborted terus langsung bail. Mekanismenya rantai `Promise` in-memory di `taskQueue.ts` — cepet, tapi mati sama proses.
4. **Persist & resume**: badan task (`runTaskPipeline`) dipisah dari `executeTask` biar bisa dipanggil ulang. Pas startup, `resumeInterruptedTasks` (`handler.ts`, dipanggil dari `index.ts` di dalam callback `app.listen`, sinkron sebelum webhook masuk bisa nyelak) baca semua baris `queued`/`running` yang ketinggalan, `planResume` (`taskQueue.ts`) misahin yang bisa dijalanin ulang dari yang harus dilepas (sudah di-resume `MAX_RESUME_ATTEMPTS`=2 kali, atau `phases_json`/project-nya udah nggak ada), lalu enqueue ulang urut `created_at` — jadi task lama tetap di depan antrean yang baru masuk. Resume = **ulang dari fase pertama**: nggak ada yang di-merge/push sampai fase terakhir, jadi work branch task yang mati itu disposable (`createWorkBranch` sekarang hapus branch `agent/<id8>` basi dulu sebelum bikin). User dikabarin "server sempat restart, task ... aku lanjutin dari awal". Task project `kind='local'` **nggak** di-resume otomatis — nggak ada work branch, editan setengah jadi masih di folder user, jadi cuma dikasih tau buat dicek manual.
5. `agent/pipeline.ts` → `runPipeline`: fase tunggal `semua` langsung dieksekusi tanpa mesin fase (checkpoint nggak berlaku di sini, nggak ada yang perlu di-pause-in). Multi-fase: tiap fase dapet system prompt yang menyertakan ringkasan fase-fase sebelumnya sebagai konteks (`buildPhaseSystemPrompt`), **cuma fase terakhir** yang boleh commit/merge/push/buka PR — fase-fase sebelumnya cuma nulis kode + kasih ringkasan serah-terima 2-4 baris, biar nggak ada riwayat commit setengah-jadi per fase.
6. Kalau checkpoint aktif dan bukan fase terakhir: pipeline pause, kirim tombol Ya/Tidak/instruksi-revisi lewat WhatsApp, nunggu `resolveCheckpoint`. `continue` → lanjut fase berikut. `revise` → fase yang sama diulang dengan instruksi revisi digabung ke konteks, lalu nanya lagi (bisa berkali-kali). `cancel` → seluruh pipeline berhenti.
7. Tiap fase jalan lewat `agent/loop.ts` (`runAgentLoop`) — loop tool-calling: panggil provider dengan daftar tool, kalau responsnya `tool_calls` eksekusi satu-satu lalu kasih hasilnya balik ke model, ulang sampai model kasih jawaban teks (itu tandanya selesai) atau `maxTurns` habis (40 buat task biasa, 15 per fase pipeline). Kalau provider error, otomatis pindah ke provider/key berikutnya dalam giliran yang sama.
8. Task git yang sukses: pesan "udah selesai" ditutup ringkasan `git diff --numstat` dari tip default branch pas task mulai (`baseSha`, diambil sebelum `createWorkBranch`) sampai HEAD sekarang — jumlah file + total `+`/`−` + beberapa file terbesar (`summarizeChangesSince`/`formatNumstat` di `git/repo.js`). Best-effort; gagal = nggak ada ringkasan, pesannya tetap kekirim.

**Tool yang tersedia** (`agent/tools.ts`): `bash` (jalan di working directory project, timeout 5 menit), `read_file`, `write_file`, `edit_file` (replace substring unik), `send_document` (kirim file project sebagai lampiran WhatsApp, cuma kalau diminta eksplisit atau memang itu tujuan tasknya). Ditambah tool `figma_*` secara dinamis kalau instruksinya mengandung link Figma dan akun sudah `hubungkan figma`.

**Proteksi**:
- `resolveWithin` — tiap `read_file`/`write_file`/`edit_file` divalidasi hasil resolve path-nya masih di dalam direktori project; `../` yang keluar dari situ ditolak.
- `isDangerousBashCommand` — pola-pola berbahaya (rm -rf ke root/home/wildcard, download-lalu-eksekusi-ke-shell, chmod 777, sudo, decode base64, reverse shell lewat netcat/`/dev/tcp`, baca file kredensial macam `.env`/`id_rsa`/`.aws/credentials`) memicu `onDangerousBash` — command itu **ditahan**, WhatsApp nanya konfirmasi user (`handlePendingBashApproval`, cuma "ya" eksak yang meloloskan, apa pun selain itu dianggap tolak). Heuristik pola teks — jaring pertama, bukan satu-satunya.
- **Sandbox `bash`** (`agent/sandbox.ts`, `AGENT_SANDBOX`, default `auto`): dua lapis. (1) **Env scrub** — child cuma dapet allowlist kecil (`PATH`, `HOME`, proxy, CA, `GITHUB_TOKEN`/`GH_TOKEN` yang emang dipake git, `LC_*`), jadi `env`/`printenv`/`echo $GEMINI_API_KEY` nggak bisa nyerahin kunci vendor atau `INTERNAL_SHARED_SECRET` ke model. (2) **Bubblewrap** (Linux + `bwrap` keinstall) — root read-only, cuma workspace task itu yang writable, `repoRoot` (tempat `.env`) + dir DB + `~/.ssh`/`~/.aws`/dst di-tmpfs jadi nggak kebaca. `none` = env scrub doang, `off` = balik ke perilaku lama. Command dijalanin lewat `execFile` (bukan `exec` + shell string) dengan env hasil scrub.
- **Secret scan sebelum commit** (`agent/secretScan.ts`, `SECRET_SCAN_ENABLED`, default on): sebelum tiap `git commit` di `runAgentLoop`, file yang ke-stage di-scan pola kredensial high-confidence (GitHub PAT `ghp_`/`github_pat_`, AWS `AKIA`, Google `AIza`, Slack, Stripe, blok private key). Ada yang match → commit **dibatalin keras** (nggak ada override WhatsApp, beda sama gate di atas), hasilnya dibalikin ke model biar dia beresin dulu. Waktu registrasi project, file tracked di-scan sekali (dibatasi jumlahnya) — kalau ada yang kena, user dapet peringatan sekali biar di-rotate.
- **Self-review sebelum commit** (`agent/selfReview.ts`, `SELF_REVIEW_ENABLED`, default **off**): sebelum `git commit` pertama di sebuah task, `reviewStagedDiff` ambil `git diff --cached` (+ `git diff` kalau `-a`), potong ~20k char, satu `provider.chat` (provider yang lagi kepakai, tanpa tool) minta daftar masalah yang bikin nggak layak commit, format `BLOCK: <isu>` per baris / `BLOCK: none`. `parseBlockingLines` (murni, tested) narik baris `BLOCK:`. Ada isu → commit ditahan, isu-nya dibalikin ke model. **Sekali per task** (`selfReviewDone` di-set sebelum call, jadi throw / "commit lagi aja" dua-duanya lewat). Fail-open: error apa pun = nggak ada gate. Beda dari secret-scan & test-gate yang keras — ini advisory.
- **Gate test/lint sebelum commit** (`agent/projectChecks.ts`, `COMMIT_CHECKS_ENABLED`, default on): persis di sebelah secret scan di `runAgentLoop`, sebelum tiap `git commit` command test/lint project (kolom `projects.test_cmd`/`lint_cmd`) dijalanin — exit non-zero → commit dibatalin keras, output-nya (dipotong) dibalikin ke model. Command-nya di-`detectProjectChecks` dari `package.json` pas project didaftarin (`indexNewProjectInBackground`) dan self-heal di task pertama kalau kolomnya masih `NULL` (project lama sebelum fitur ini). `NULL` = belum kedeteksi, `''` = gak ada cek (jadi auto-detect nggak jalan ulang). Override lewat WhatsApp: `atur cek test/lint <cmd|off>` (`parseSetCheck` → `handleSetCheckCommand`, di project aktif). Jalan lewat `bashInvocation` yang sama kayak tool `bash` (env scrub + bubblewrap), timeout 10 menit per command. Di-thread dari `runTaskPipeline` → `runPipeline` → `runAgentLoop` sebagai `commitChecks`.
- Prompt sistem tiap fase (`systemPrompt.ts`) selalu menyertakan peringatan anti-prompt-injection: apa pun yang dibaca lewat tool (isi file, output command, konten Figma) adalah data buat diperiksa, bukan instruksi buat diikuti — kalau ada teks yang kayak nyoba ngarahkan model ("ignore previous instructions", dst), jangan dituruti, cukup disebut di ringkasan akhir.

## Konteks kode (RAG)

Opsional, mati secara default (`RAG_ENABLED`). Tujuannya: ngasih agent potongan kode yang relevan di awal fase, biar turn budget nggak abis buat `grep`/`find`/`read_file` nyari file. Kode di `apps/orchestrator/src/agent/rag/`.

- **Embedding**: model lokal yang sama kayak chat KB (`agent/localEmbedder.ts` via `LocalEmbeddingProvider` di `agent/rag/embeddingProvider.ts`) — CPU, tanpa API, tanpa rate limit. `RAG_ENABLED=true` tanpa `@huggingface/transformers` cuma jadi no-op, nggak pernah nggagalin task. `code_index_meta.embed_model` nyimpen identitas model; ganti model → reindex penuh.
- **Penyimpanan**: tabel `code_files` / `code_chunks` / `code_index_meta` di `orchestrator.sqlite` (`db/rag.ts`). Vektor disimpen sebagai blob `Float32Array`; retrieval-nya cosine brute-force di JS (`cosineSimilarity` di `agent/rag/index.ts`) — cukup buat skala satu repo, `sqlite-vec` baru perlu kalau satu project nembus puluhan ribu chunk.
- **Chunking** (`agent/rag/chunker.ts`): **per-simbol dulu** — potong di batas fungsi/kelas/tipe (heuristik regex per language family: TS/JS, Python, Go, Rust, Ruby, PHP, JVM-ish; sampai ~1 level indentasi biar method kelas ikut). Blok kecil yang berdampingan digabung sampai `RAG_CHUNK_LINES`; simbol tunggal yang > 1.5x itu di-window. Bahasa yang nggak keparse (C/C++, dll) atau file dengan < 2 boundary → **fallback** ke window baris ~60 overlap ~10 kayak sebelumnya. Tiap chunk tetap di-prefix `// <path>:<baris>` biar path ikut ke-embed. `shouldIndexFile` nyaring ekstensi + skip file > 256KB / minified / `node_modules` dsb. (Ganti chunker nggak nge-reindex otomatis — chunk lama kepakai sampai file-nya berubah / model embedding ganti / project di-add ulang.)
- **Indexing**: inkremental per-file lewat hash SHA-1 — cuma file yang hash-nya berubah yang di-embed ulang.
  1. Pas registrasi project (`registerGitProject` / `confirm_add_folder` di `handler.ts`) — jalan di background, nggak nahan balasan.
  2. Pas tiap task (`executeTask`, sebelum `runPipeline`) — refresh cepat; kalau HEAD default branch nggak gerak sejak index terakhir, langsung skip.
  3. `hapus project` → `deleteProjectIndex`.
  Serialisasi per-alias (`projectLocks` di `agent/rag/index.ts`) biar index dari registrasi dan dari task pertama nggak balapan.
- **Retrieval**: `retrieveCodeContext` (`pipeline.ts` manggil per fase, query = instruksi + `phase.note`; `runner.ts` buat shortcut `semua`). Hasilnya disisipin sebagai `role:"system"` lewat `extraSystemNotes` di `runAgentLoop` — pola yang sama kayak `FIGMA_TOOLS_SYSTEM_NOTE`. `buildPhaseSystemPrompt` sendiri nggak disentuh.
- **Lintas-repo** (opt-in, `RAG_CROSS_REPO=true`): retrieval juga ambil chunk paling cocok dari project **lain** yang keregister, dibatasi `floor(RAG_TOP_K / 3)` dan ambang skor yang sama, jadi project aktif tetap dominan. Cuma project yang di-index pakai model embedding sekarang yang eligible (`crossRepoChunks` join ke `code_index_meta.embed_model` — vektornya harus sebanding). Chunk lintas-repo di-label `--- [project <alias>] <path>:<baris> ---` dan header retrieval-nya nambahin peringatan: itu contoh dari repo lain, **bukan** file di repo yang lagi dikerjain, jangan diedit/direferensiin seolah-olah iya.
- **Selalu additive**: embedding gagal / rate limit / RAG mati → retrieval balik `undefined`, loop jalan persis kayak sebelum ada RAG. Potongan kode hasil retrieval masuk kelas data gak-tepercaya yang sama di `SHARED_UNTRUSTED_CONTENT_RULE`.

## Chat biasa & memori

Kalau `classifyMessageKind` bilang `chat` (bukan task), `handleChatMessage` (`agent/chatAssistant.ts`) yang jalan — beda dari balasan statis di `dynamicReplies.ts` (dipakai buat intro/greeting/help/explain, satu tembakan tanpa histori, cuma digrounding ke fakta tetap yang ditulis di prompt):

- Sebelum manggil AI: kalau pesannya ekspresi aritmatika murni ("berapa 234 x 213?"), dihitung sendiri secara deterministik (`agent/calc.ts` — shunting-yard kecil, tanpa `eval`) dan langsung dibalas. Model gratisan sering salah ngitung angka besar dan ngarang desimal; ini juga hemat satu panggilan. Selain ekspresi bersih, semua jatuh ke jalur AI seperti biasa.
- Ambil 12 pesan terakhir dari `chat_history` (tabel di-prune ke maksimal 40 baris per nomor tiap kali nambah baris baru) buat konteks obrolan.
- Ambil sampai 30 fakta terakhir dari `user_memory` (permanen, lintas sesi — beda dari `chat_history` yang cuma histori pendek) buat digrounding ke prompt.
- Satu panggilan AI ngerjain dua hal sekaligus: kasih balasan natural, **dan** di baris terakhir opsional nyebutin satu fakta baru yang layak diinget (`FACT: ...` atau `FACT: tidak ada`) — sengaja satu panggilan, bukan dua, biar nggak dobel biaya tiap pesan obrolan.
- User bisa `lihat memori` (tampilin semua fakta tersimpan) atau `lupain semua` (hapus semua, minta konfirmasi dulu — ini permanen).

### Model lokal buat chat non-koding

Opsional, mati default (`CHAT_LOCAL_LLM`). Model instruct kecil lokal (`agent/localLlm.ts` — default `Qwen2.5-1.5B-Instruct` q4, CPU, lewat `@huggingface/transformers`) jawab chat non-koding **sebelum** Gemini dicoba. Dipanggil di `generateChatReply` setelah aritmatika + cache KB, sebelum `provider.chat`. Gagal/timeout/jawaban kosong/lolos `isUsableLocalReply` (buang echo prompt, echo pertanyaan, loop) → jatuh ke Gemini. `source: "local"`. Prompt-nya sengaja pendek (`buildLocalSystemPrompt` — persona + style, tanpa histori, tanpa ekstraksi FACT). Jawaban lokal **nggak di-cache** (model gratis di-run ulang, membaik pas di-tune, output-nya jangan nyampur ke dataset distilasi). Pipeline koding nggak kesentuh. Model di-warm pas startup (log "ready in Ns").

**Kualitas**: diuji, model 0.5B fasih tapi **ngarang fakta dasar** ("kemerdekaan Indonesia → 24 Agustus 1945"). 1.5B lantai minimum; buat bener-bener bagus, fine-tune pakai output `npm run export:dataset`. `isUsableLocalReply` nangkep degenerasi, **bukan** halusinasi percaya-diri — itu butuh grounding (RAG/KB).

### Chat knowledge base

Opsional, mati default (`CHAT_KB_ENABLED`). Konsepnya: pertanyaan non-koding **baru** dijawab Gemini dan jawabannya disimpan; pertanyaan **yang sama diulang** dijawab dari store itu, bukan Gemini. Kode di `agent/chatKb.ts` + `db/chatKb.ts`.

- **Rekam**: tiap Q&A chat bebas (`handleChatMessage`) dicatat ke `interaction_kb` lewat `recordInteraction` — fire-and-forget, gagal di sini nggak pernah nyentuh balasan yang udah dikirim. Yang disimpan termasuk `norm_question` (pertanyaan di-lowercase, buang tanda baca/diakritik, rapetin spasi).
- **Normalisasi** (`normalizeQuestion`, `db/chatKb.ts`): huruf kecil, buang tanda baca/diakritik, buang kata pengisi (`sih/dong/kok/yang/itu/...`), samakan varian ejaan & sinonim lewat peta buatan tangan (`nggak`→`tidak`, `lo`→`kamu`, `bagaimana`→`gimana`, `penemu`→`temu`, `bikin`→`buat`, dst — peta di `db/chatKb.ts`, tinggal ditambah). Semua baris di-recompute pas startup kalau petanya berubah.
- **Ambil** (`lookupCachedAnswer`, dipanggil di `generateChatReply` setelah cek aritmatika, sebelum panggilan model) — **lokal, tanpa panggilan API**:
  - cocok persis di `norm_question` → pakai jawaban tersimpan (yang terbaru).
  - kalau nggak, Jaccard antar token-set ≥ `CHAT_KB_LOCAL_THRESHOLD` (default 0.85) → pakai. Nangkep beda tanda baca, huruf besar/kecil, urutan kata, kata pengisi, dan varian ejaan/sinonim yang ada di peta.
  - hit → `source: "kb"`, nol panggilan Gemini. Handler nggak nyimpen ulang.
- **Fallback semantik** (opt-in, `CHAT_KB_SEMANTIC=true`): kalau cocok lokal meleset, embed pertanyaan pakai **model kalimat lokal kecil** (`agent/localEmbedder.ts` — `paraphrase-multilingual-MiniLM-L12-v2` q8, ~120MB, CPU, lewat `@huggingface/transformers`; **tanpa API, tanpa rate limit**) dan cosine lawan baris ter-embed (juga di-embed lokal pas direkam), ambang `CHAT_KB_MATCH_THRESHOLD` (0.75). Nangkep parafrase makna ("tanggal berapa indonesia merdeka" ≈ "kapan hari kemerdekaan indonesia"). Model diunduh sekali ke `data/hf-cache/`, di-warm pas startup. Butuh `@huggingface/transformers` kepasang (~200MB node_modules); kalau nggak ada, fallback-nya diam-diam mati.
- Jawaban aritmatika (`source: "arithmetic"`) dicatat tapi nggak pernah jadi kandidat — `agent/calc.ts` udah generalisasi.
- **Data usang** ditangani empat lapis:
  1. `isVolatile` (`agent/chatKb.ts`) — pas rekam, pertanyaan/jawaban dengan penanda time-sensitive (harga/kurs/cuaca/"sekarang"/"terbaru"/jabatan/tahun 20xx/...) disimpan sebagai `chat_volatile` yang nggak pernah dicocokin. Bias over-flag (rugi paling banter satu panggilan model ekstra).
  2. TTL `CHAT_KB_MAX_AGE_DAYS` (default 90) — baris lebih tua di-skip pas lookup, pertanyaan balik ke model, jawaban ditimpa (insert `chat_model` ngehapus baris `norm_question` yang sama dulu).
  3. Tanda umur — jawaban dari cache yang usianya >14 hari dapet embel-embel "(ini jawaban tersimpan dari ~sebulan lalu, bisa aja udah berubah)".
  4. Koreksi user — kalau pesan **tepat setelah** balasan `kb` bereaksi ke situ, baris tersimpan dihapus. Tiga bentuk (`consumeKbCorrection`): koreksi polos ("salah") → tanya ulang model; koreksi + petunjuk ("salah, mestinya X yang terjadi") → tanya ulang model dengan petunjuk itu di prompt (`extraContext`, lookup di-skip); user kasih jawabannya ("jawabannya X" / "harusnya X") → langsung disimpan tanpa panggil model. Registry in-memory `lastKbHit` (window 6 menit), dicek di `tryHandleKbCorrection` sebelum command matching.
- **Shared antar-sender** (opt-in, `CHAT_KB_SHARED=true`, cuma relevan kalau `ALLOWED_SENDERS` isinya > 1 nomor): lookup (`candidatesForLocalMatch`/`embeddedForNumber`/backfill) ngerange ke baris **semua** sender, bukan cuma pemanggil — pertanyaan yang udah dijawab buat satu orang kejawab dari cache buat yang lain, hit rate naik. `recordInteraction` tetap nyimpen `from_number` asli (provenance); dedup insert & koreksi (`deleteByNorm`) jadi per-`norm_question` global, jadi re-answer/koreksi ganti satu entri global bukan copy per-orang. `lupain semua` tetap per-sender — cuma ngehapus kontribusi si pemanggil, bukan seluruh pool. Aman karena yang disimpan cuma Q&A faktual non-volatile; hal personal ada di `user_memory`, bukan sini. Index `idx_interaction_kb_norm_shared` (`norm_question` doang) buat query lintas-sender ini.
- **Multi-turn**: sengaja **nggak** di-cache. Pertanyaan lanjutan yang nyandar ke konteks obrolan (`needsConversationContext` true) selalu ke model — nggak ada key yang stabil buat nyimpennya (konteksnya beda tiap kali), dan nyaji jawaban lanjutan lama buat konteks yang beda persis kelemahan yang desain ini hindarin ("wrong reuse worse than a miss"). Yang dimaksud "pertanyaan diulang" = pertanyaan standalone yang sama, itu jalur yang udah ada.
- **Batasnya**: cuma bantu pertanyaan yang beneran diulang (wording mirip). Pertanyaan baru tetap ke Gemini. Jawaban tersimpan bisa salah kalau Gemini-nya yang salah — koreksi user (#4) jalan keluarnya.
- `lihat memori` nunjukin jumlah tersimpan **plus statistik**: persen dijawab **tanpa Gemini** 30 hari (`(kb + arithmetic + local) / total`), tren minggu-ini vs minggu-lalu, dan berapa yang **nyaris cocok** (`model_nearmiss` — skornya tepat di bawah ambang). Dari `chat_stats`, counter per `(hari, source)` di-bump di `handleChatMessage`. Ini angka pemutus — kalau rendah dan tetap rendah, lapisan KB bisa dimatiin.
- `npm run export:dataset --workspace apps/orchestrator` (`scripts/export-kb-dataset.ts`) nge-dump baris `chat_model` jadi JSONL `{"messages":[{user},{assistant}]}` — dataset siap fine-tune/distilasi buat langkah "model lokal generatif".
- **Usul sinonim otomatis**: pas text near-miss di mana dua pertanyaan cuma beda 1-2 token per sisi, pasangan token itu di-count di `kb_synonym_hints` (`recordSynonymHint`). `lihat memori` nampilin yang count ≥ 3; `npm run kb:hints` daftar lengkap. Sinonim beneran naik ke atas seiring sampel; tinggal ditambah manual ke peta `SYNONYM`.
- `lupain semua` ikut ngehapus `interaction_kb` (`chatKbRepo.clearForNumber`); `chat_stats` nggak (statistik agregat, bukan data pribadi).

## `review PR <nomor>`

`parseReviewPr` (deterministik — ada argumen nomornya) → `handleReviewPrCommand`. Bukan lewat pipeline: cuma baca + satu panggilan model. `ensureWorkspace` project aktif (harus `kind='git'`) → `agent/prReview.ts` `gatherPrContext` nembak `gh pr view --json ...` + `gh pr diff` di workspace itu (`gh` baca `GITHUB_TOKEN` dari env, repo diinfer dari origin), diff dipotong di batas baris kalau > 24k char → `buildReviewPrompt` → `providers[0].chat` (tanpa tool) → review dibalikin ke WhatsApp. Review-nya distash di `pending_action: confirm_post_pr_review`; balas "ya" → `gh pr comment <n> --body <review>`. Nggak pernah auto-post — selalu nunggu konfirmasi.

`daftar PR` (`isListPrsCommand` → `handleListPrsCommand`) — `listOpenPrs` (`gh pr list --state open --json number,title,headRefName,isDraft,url`) di clone yang udah ada, **tanpa** `ensureWorkspace`/pull, jadi tetep jalan meski ada task lagi megang workspace-nya. `formatPrList` (murni, tested) buat teksnya; PR non-draft jadi tombol `merge pr <n>`. `merge PR <nomor>` (`parseMergePr` → `handleMergePrCommand`) → `pending_action: confirm_merge_pr` → balas "ya" → `ensureWorkspace` + `mergePr` (`gh pr merge <n> --squash --delete-branch`).

## Pantau CI setelah push (`watchCiAndReport`)

Nyala default (`CI_WATCH_ENABLED`). Di ujung `runTaskPipeline`, cuma buat task git yang `result.ok`, dipanggil fire-and-forget (`void watchCiAndReport(...)`) — sengaja **nggak** di-await biar antrian task project itu (`taskQueue.ts`) nggak ketahan selama beberapa menit poll.

`latestRemoteSha` (`git/repo.ts`) — `git fetch origin <branch>` + `rev-parse origin/<branch>` — buat tau commit mana yang mau diawasin (checkout lokal bisa ketinggalan / masih di work branch). Lalu `watchCiForSha` (`agent/ciWatch.ts`) nge-loop `gh run list --json databaseId,headSha,status,conclusion,url,workflowName` tiap 20 detik. `classifyRuns` (murni, fully tested) misahin run yang `headSha`-nya cocok: ada yang belum `completed` → `pending` (lanjut poll); semua kelar & ada `conclusion` di {`failure`,`timed_out`,`startup_failure`,`action_required`} → `failure`; selain itu `success`. `cancelled` **bukan** kegagalan (orang yang batalin manual). Nol run cocok selama > 120 detik → `none` (branch ini nggak ada CI-nya). Lewat `CI_WATCH_TIMEOUT_MINUTES` → `timeout`.

- `success` → satu baris "CI ... lulus".
- `failure` → `gh run view <id> --log-failed` buat run pertama yang gagal, log dipotong ke ~4k char (tail). Kalau `conversation_state.pending_action` lagi keisi (user di tengah wizard lain), cuma dikirim teksnya — nggak nyetel pending baru biar nggak nimpa. Kalau kosong, disimpen `pending_action: confirm_ci_fix` + tombol Ya/Tidak.
- `none`/`timeout`/`error` → diem.

`confirm_ci_fix` di-`handlePendingConfirmation`: "ya" → log kegagalan jadi instruksi task biasa, `classifyDepartments` fresh, `executeTask` (tanpa konfirmasi rencana — user udah nyetujui pas tap "Ya"). Task fix-nya masuk antrian project itu kayak task lain.

## `batalin yang barusan` — undo task terakhir

`isUndoLastCommand` (frasa persis: `undo`, `batalin yang barusan`, `batalin task terakhir`, dst) → `handleUndoLastCommand`. Cuma project git aktif, nggak ada task lagi jalan. `tasksRepo.lastPushedGitTask` ambil task `done` terakhir yang `base_sha != result_sha` (dua kolom itu diisi di ujung `runTaskPipeline` pas task git sukses — `baseSha` diambil sebelum `createWorkBranch`, `resultSha` = `latestRemoteSha` setelah push). Tampilin instruksinya + tombol Ya/Tidak, simpen `pending_action: confirm_undo_last` (bawa `baseSha`/`resultSha`/branch).

"ya" di `handlePendingConfirmation` → `revertRange` (`git/repo.ts`): `checkout branch` → `pull --ff-only` → `git revert --no-commit <base>..<result>` → satu `git commit` → `push`. Tiap tahap di-try/catch — gagal di mana pun (branch diverged, push ditolak, revert bentrok, merge commit di range yang butuh `-m`, range kosong) balikin `{ ok: false, error }`, **nggak pernah throw**; kalau `revert` udah kebikin tapi commit/push gagal, staged-nya sengaja dibiarin biar bisa dibereskan manual. Deterministik, bukan lewat pipeline — sebangun sama `postPrComment` di `review PR`. Jaring pengaman buat `auto_merge = 'direct'`.

Batasan: `base..result` di-revert apa adanya, jadi kalau ada commit orang lain nyempil di range itu (mis. push manual ke branch utama pas task lagi jalan) commit itu ikut kebalik. Di mode `direct`, kasus ini biasanya kejadian bareng non-FF merge → ada merge commit → `revertRange` udah bail duluan. Mode `pr` + squash gak punya proteksi itu — fix beneran butuh nyimpen daftar SHA commit yang task-nya bikin.

`diff terakhir` (`isLastDiffCommand` → `handleLastDiffCommand`) pakai `base_sha`/`result_sha` yang sama: `diffBetween` (`git diff <base> <result>`) → kirim sebagai lampiran `.diff.txt` (`.diff`/`.patch` nggak ada di allowlist dokumen), dipotong di 4MB. Read-only.

## `screenshot` — jepret tampilan

`isScreenshotCommand` → `handleScreenshotCommand` (`config.screenshot.enabled`, default on). `agent/screenshot.ts`:
- `detectDevCommand` (murni, tested) — ambil script pertama dari `["dev","preview","start","serve"]` di `package.json`, runner dari lockfile.
- `hasNodeModules` kosong → `installDeps` (`npm/yarn install`, timeout 5 mnt).
- `startPreview` — `spawn(runner, ["run", script], { detached: true, env: { BROWSER: "none", CI: "1" } })`, kumpulin stdout/stderr, `extractLocalUrl` (murni, tested — regex `localhost|127.0.0.1|0.0.0.0:port`, dinormalin ke `127.0.0.1`) ketemu → tunggu 1.5 dtk → resolve `{ url, stop }`. Timeout 60 dtk / exit dini → reject. `stop()` = `process.kill(-pid, SIGTERM)` lalu SIGKILL setelah 3 dtk (kill process group biar vite/next child ikut mati).
- `screenshotUrl` — `puppeteer-core` + `@sparticuz/chromium` (`chromium.args`, `await chromium.executablePath()` unpack brotli ke `/tmp` sekali, `headless: true`), `page.goto(networkidle2, 30s)` dengan satu retry `domcontentloaded`, `page.screenshot({ fullPage: true })` → PNG base64.

`finally { preview.stop() }` — dev server selalu dimatiin. Hasil dikirim lewat `sendWhatsAppImage` → gateway `/send-image` → `uploadMedia` + `type:"image"`. `orchestrator.Dockerfile` nambah ~18 `lib*` + `fonts-liberation` (GTK sengaja nggak — new headless mode nggak butuh); browser binary-nya ~60MB dari `@sparticuz/chromium` di `node_modules`.

## `deploy` — ke Vercel

`isDeployCommand` → `handleDeployCommand`. Token-gated: `config.deploy.vercelToken` kosong → cuma balesan minta isi `VERCEL_TOKEN` (pola "dibangun, butuh config" yang sama kayak Figma). Ada token → `ensureWorkspace`/`ensureLocalFolder`, terus `deployToVercel` (`agent/deploy.ts`) `execFile("npx", ["--yes", "vercel@latest", "--prod", "--yes", "--token", <tok>], { cwd })`, timeout 8 menit (+ AbortController 9 menit di handler). `extractDeployUrl` (murni, tested) narik URL `*.vercel.app` dari output, fallback ke https URL pertama. Bukan pipeline.

## `di a, b: <instruksi>` — multi-repo

`parseMultiRepo` — `di <daftar-alias>: <instruksi>`, tiap bagian sebelum titik dua yang dipisah koma harus token alias polos (`[A-Za-z0-9._-]+`), jadi "di halaman login: ..." nggak ke-match. → `handleMultiRepoInstruction`: 1 alias → `classifyAndPresentPlan` biasa (jadi juga shortcut nge-target project non-aktif). ≥2 alias → `classifyDepartments` **sekali** (instruksi sama → departemen kemungkinan sama, hemat call), satu preview rencana, `pending_action: confirm_multi_pipeline` (bawa `aliases`/`instruction`/`phases`). "ya" → loop `executeTask(..., announce=false)` per repo — masing-masing baris `tasks` sendiri, masuk antrian project-nya sendiri, jalan paralel (dibatasi `maxConcurrentTasks`), lapor hasil sendiri-sendiri. Satu combined "jalan di N repo" di depan. Nggak ada checkpoint mode buat multi.

## `tanya: <pertanyaan>` — Q&A read-only atas repo

`parseAskRepo` (butuh titik dua biar beda dari chat biasa) → `handleAskRepoCommand`. Project aktif (git atau folder lokal), nggak ada task lagi jalan. `ensureWorkspace`/`ensureLocalFolder` → `retrieveCodeContext` (potongan RAG, kalau nyala) → `runAgentLoop` dengan `readOnly: true`, `maxTurns: 12`, prompt dari `buildRepoQaSystemPrompt`. Nggak lewat pipeline, nggak ada `taskId` di tabel `tasks` (id-nya `ask-<uuid8>`, cuma nyangkut di `audit_log`).

`readOnly` di `loop.ts`: schema tool disaring ke `bash` + `read_file` doang; kalau model tetep manggil `write_file`/`edit_file`/`send_document` atau `bash` yang `isWriteBashCommand` (`agent/tools.ts` — redirection, `rm`/`mv`/`cp`/dst, git subcommand yang mutasi, `npm/pnpm/yarn install/add/run`, `npx`, `pip install`, `sed -i`), balikin error tool dan `continue`. Heuristik, bukan sandbox — tool `bash` tetep jalan dengan permission OS orchestrator, ini cuma jaga sesi Q&A nggak nyeleneh commit/install/hapus.

## `kerjain issue <nomor>`

`parseWorkIssue` (deterministik — bawa nomor issue-nya) → `handleWorkIssueCommand`. `ensureWorkspace` project aktif (harus `kind='git'`, dan nggak ada task lagi jalan di situ) → `agent/issue.ts` `gatherIssueContext` nembak `gh issue view <n> --json number,title,body,state,labels,url,comments` (body dipotong ~6k char, sampai 6 komentar terakhir masing-masing ~800 char). Issue `CLOSED` → ditolak dengan penjelasan (buka lagi di GitHub dulu). Selain itu `buildIssueInstruction` (murni, tested) nyusun konteksnya jadi teks instruksi task biasa + baris `Closes #<n>`, terus `classifyAndPresentPlan(..., allowClarify=false)` — dari sini persis kayak instruksi free-text: klasifikasi departemen → konfirmasi rencana → pipeline. Bukan jalur eksekusi sendiri, cuma bikinin teks yang instruksi manual bakal bikin sendiri.

## Task terjadwal (`jadwalkan tiap <kapan>: <instruksi>`)

`parseScheduleCommand` (`router/parse.ts`) misahin frasa jadwal dari instruksi di titik dua pertama; `parseSchedule` (`agent/schedule.ts`, murni + fully tested) nge-parse frasanya jadi `ScheduleSpec` — `daily` / `weekly` (dow 0=Minggu) / `monthly` (day di-clamp ke panjang bulan) / `everyHours` (n ∈ {1,2,3,4,6,8,12}). Jam default 08:00, ngerti `pagi/siang/sore/malam`. Semua wall-clock di WIB via offset tetap +7 (Indonesia nggak ada DST, jadi nggak perlu `Intl` round-trip). Baris disimpen di `scheduled_tasks` dengan `next_run_at` hasil `computeNextRun`.

`startScheduleRunner` (`handler.ts`, dipanggil dari `index.ts`) — `setInterval` 60 detik, loop background **kedua** setelah `idleNotifier`. Tiap tick: `scheduledTasksRepo.due(now)` → buat tiap yang jatuh tempo, **majuin `next_run_at` dulu** (biar run lambat nggak dobel-trigger di tick berikutnya) baru `fireScheduledTask`: `classifyDepartments` fresh (deps/kode bisa geser antar-fire) → `executeTask` langsung, tanpa konfirmasi (user udah opt-in pas bikin jadwal). Project udah nggak ada → jadwalnya dihapus + user dikabarin. `hapus project` juga ngebersihin `scheduled_tasks` project itu.

## Ringkasan harian (`startDailyDigest`)

Loop background **ketiga**, cuma nyala kalau `DAILY_DIGEST_ENABLED=true`. `setInterval` 5 menit; tiap tick cek jam WIB — kalau `=== DAILY_DIGEST_HOUR` dan `kv['digest:lastYmd']` bukan hari ini, **set kv-nya dulu** baru `runDailyDigest`: `tasksRepo.recentlyFinished(24)` + `scheduledTasksRepo.upcomingWithin(now+24h)` + `coolingDownNow()` + `providerUsageRepo.forDate(kemarin)` → `buildDigestText` (murni, `agent/digest.ts`, tested) → `sendWhatsApp(config.ownerNumber, ...)`. Set-kv-sebelum-kirim = pola yang sama kayak schedule runner majuin `next_run_at` dulu, jadi kirim yang gagal nggak retrigger sejam itu.

## `status` — dasbor ringkas

`handleStatusCommand` selain nunjukin task yang lagi jalan + posisi antrean, sekarang selalu nutup dengan `dashboardBlock`: rollup task 7 hari (`tasksRepo.stats` — selesai/gagal/batal + rata-rata durasi dari `finished_at - created_at`), baris chat-autonomy 30 hari yang sama kayak di `lihat memori` (`chatKbStatsLine`, cuma kalau `CHAT_KB_ENABLED`), daftar provider yang lagi di cooldown 429 (`coolingDownNow`, cuma kalau ada), dan **panggilan AI hari ini per key/model** (`providerUsageRepo.today()` — di-bump di `runAgentLoop` tiap `provider.chat` sukses, keyed `provider.id` = `name@model#keyhash`, WIB, tabel `provider_usage`). Buat proyek aktif juga nampilin gate test/lint-nya (`activeProjectChecksLine`).

## Registrasi project & git

`registerGitProject` → `git/repo.ts` `ensureWorkspace`: clone (kalau belum ada `.git` di `workspaces/<alias>`), lalu **deteksi branch default sebenarnya** dari `refs/remotes/origin/HEAD` (bukan asumsi `"main"` — repo yang default branch-nya beda, misal `master`, atau yang masih kosong sama sekali tanpa commit, dulu gagal dengan error git mentah yang kekirim langsung ke WhatsApp; sekarang dideteksi dan kalau beda dari yang tersimpan di DB, tabel `projects` di-self-heal). Kalau registrasi gagal di tengah jalan, baris project yang kadung dibikin di-rollback (dihapus) — supaya user bisa coba lagi tanpa kejebak status "udah ada" padahal clone-nya nggak pernah beres.

Kredensial GitHub **nggak pernah** disimpen di URL remote atau di disk — `ensureGithubCredentialHelper` masang git credential helper global (`git config --global credential.https://github.com.helper`) yang baca `GITHUB_TOKEN` langsung dari environment proses saat diminta git, di-scope ke host `github.com` doang. `isAllowedRepoUrl` (`router/parse.ts`) cuma menerima `https://github.com/<owner>/<repo>` persis — nolak transport helper git kayak `ext::sh -c ...` (RCE lewat clone) dan host selain github.com (yang kalau lolos bakal ditawarin kredensial GitHub kita pas fetch).

## Keamanan — ringkasan

- **`ALLOWED_SENDERS`** dicek dua kali: di gateway (drop sebelum forward) dan di orchestrator (403 kalau lolos gateway tapi nggak allowlisted — jaga-jaga endpoint internal dipanggil dari jalur lain).
- **`X-Internal-Secret`** wajib di tiap panggilan gateway↔orchestrator.
- **HMAC signature** wajib buat tiap webhook dari Meta.
- **`isAllowedRepoUrl`** & **credential helper** — lihat bagian di atas.
- **`isDangerousBashCommand`** + persetujuan WhatsApp, **sandbox `bash`** (env scrub + bubblewrap), **secret scan sebelum commit** — lihat bagian Eksekusi task.
- **Peringatan anti-prompt-injection** di tiap system prompt fase.
- **`audit_log`** — tiap tool call, progress note, error dicatat per `task_id`, jadi jejak audit apa yang sebenarnya dikerjakan agent secara otonom.
- Batas ukuran per endpoint: `/inbound` 8MB (gambar base64), `/send-document` 20MB (dokumen base64), gambar masuk maks 5MB, dokumen keluar maks 16MB — semuanya di-scope per-route, bukan limit global.

## Skema database (SQLite, `better-sqlite3`)

| Tabel | Isi |
|---|---|
| `projects` | Project terdaftar — alias, remote/path, default branch, mode auto-merge, git atau folder lokal, command test/lint pre-commit (`test_cmd`/`lint_cmd`). |
| `tasks` | Satu baris per eksekusi task dan hasilnya. `phases_json` + `checkpoints` + `resume_count` bikin task yang ketinggalan pas restart bisa dijalanin ulang (lihat "Persist & resume"). |
| `audit_log` | Jejak tiap tool call/note/error per task. |
| `conversation_state` | State per nomor WhatsApp — project aktif, `pending_action`, provider pilihan. |
| `figma_oauth` | Token OAuth Figma (single-tenant, satu baris). |
| `user_memory` | Fakta permanen lintas sesi soal tiap user. |
| `chat_history` | Histori obrolan biasa terbaru (bukan task), dipangkas otomatis. |
| `processed_messages` | Guard dedup buat webhook yang dikirim ulang (`inboundDedup.ts`) — persisten di DB, bukan `Map`, biar restart di tengah window retry (default 1 jam) nggak ngebuka celah yang harusnya ketutup. |
| `scheduled_tasks` | Task rutin dari `jadwalkan ...` — `spec_json` (parsed `ScheduleSpec`), `next_run_at`. Runner 60-detik di `startScheduleRunner`. Lihat "Task terjadwal". |
| `interaction_kb` | Chat knowledge base (`db/chatKb.ts`) — tiap Q&A chat bebas, `norm_question`, opsional embedding. Cuma keisi kalau `CHAT_KB_ENABLED`. Index `norm_question` doang buat lookup `CHAT_KB_SHARED`. Lihat "Chat knowledge base". |
| `chat_stats` | Counter per `(hari, source)` buat balasan chat (`kb`/`arithmetic`/`model`/`model_nearmiss`) — `lihat memori` buat persen tanpa-AI + tren + near-miss. |
| `kb_synonym_hints` | Pasangan token yang sering beda di near-miss — kandidat sinonim buat peta `SYNONYM`. `npm run kb:hints`. |
| `provider_usage` | Hitungan panggilan agent-loop per `(ymd WIB, provider_id)` — buat baris "panggilan AI hari ini" di `status`. |
| `kv` | Key/value kecil buat state yang nggak layak tabel sendiri (mis. tanggal digest harian terakhir dikirim). |
| `code_files` / `code_chunks` / `code_index_meta` | Index kode buat RAG (lihat "Konteks kode") — hash per file, chunk + vektor embedding, penanda HEAD/model terakhir. Cuma keisi kalau `RAG_ENABLED`. |
