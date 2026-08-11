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
1. Ada pending bash-approval (in-memory)?  ──▶ handlePendingBashApproval
2. Ada pending checkpoint (in-memory)?     ──▶ handlePendingCheckpoint
3. Ada pending_action tersimpan di DB?     ──▶ handlePendingConfirmation
4. Ada gambar?                             ──▶ handleImageMessage
5. Cocok salah satu command deterministik  ──▶ handler masing-masing
   (intro/greeting/help/daftar project/daftar model/status/stop/
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
| `confirm_clear_memory` | Konfirmasi ya/tidak sebelum menghapus semua memori soal user itu. |

Dua state lain — persetujuan bash berbahaya dan checkpoint antar-fase pipeline — **bukan** bagian union ini; keduanya in-memory, per-`taskId`, hidup selama proses orchestrator jalan dan task itu masih aktif (`agent/bashApproval.ts`, `agent/checkpoint.ts`, keduanya pola registry `Map<taskId, resolver>` yang sama).

**Jalan keluar dari wizard yang "kejebak"** (`looksLikeAnotherCommand`, dipanggil di awal `handlePendingConfirmation` dan `handlePendingBashApproval`): kalau pesan yang masuk ternyata jelas-jelas command lain yang valid (misal ngetik "halo" pas lagi ditanya link GitHub), pending state dibatalin dan pesan itu lanjut diproses sebagai command aslinya — bukan dipaksa jadi jawaban buat pertanyaan yang lagi nunggu. `handlePendingCheckpoint` sengaja **tidak** pakai jalan keluar ini — di situ, apa pun selain ya/tidak memang sengaja dianggap instruksi revisi, itu desain yang disengaja.

## Provider AI — fallback chain

`agent/runner.ts`:
- `AI_PROVIDER_ORDER` (env, default `gemini,openrouter,qwen`) → tiap nama di-expand jadi satu `Provider` per API key yang dikonfigurasi buat nama itu (`GEMINI_API_KEY=key1,key2` → 2 provider instance terpisah). Hasilnya satu array panjang, urutan provider lalu urutan key.
- `preferred_provider` (diset lewat "pakai model semua/\<departemen\> \<nama\>") memindahkan **seluruh grup key** provider itu ke depan array, tanpa mempersempit provider lain yang tetap ada di belakang sebagai fallback.
- Kalau satu provider/key gagal atau kena rate limit di tengah `agent/loop.ts`, loop otomatis lanjut ke entry berikutnya dalam array yang sama — **tanpa mengulang task dari awal**, cuma retry giliran itu dengan provider baru.

Tiap provider (`providers/gemini.ts`, `providers/openAiCompatible.ts`) implement interface `Provider` yang sama (`chat(messages, tools, signal)`, opsional `describeImage(...)`) — kode di atasnya (loop, classifier, chat assistant) nggak pernah tahu lagi vendor mana yang lagi dipakai.

## Empat klasifier AI satu-tembakan

Semua pakai pola yang sama: satu prompt, satu pesan `role:"user"`, minta jawaban satu baris format ketat, di-parse baris-per-baris (toleran kalau modelnya nggak persis ngikutin format), gagal (exception/parse miss/respons non-teks) selalu jatuh ke default yang aman — nggak pernah nebak ke arah yang lebih berisiko.

| Classifier | Mutusin | Default kalau gagal |
|---|---|---|
| `classifyCommandIntent` | Parafrase dari 9 command tetap, atau `none` | `none` |
| `classifyMessageKind` | `task` vs `chat` | `task` — ambigu selalu dianggap task sungguhan, nggak pernah diam-diam dianggap obrolan |
| `classifyConfirmationIntent` | `yes`/`no`/`unclear` buat jawaban konfirmasi | `unclear` — nggak pernah nebak jadi "yes" |
| `classifyDepartments` | Daftar fase departemen buat task koding | Satu fase `semua` (catch-all) |

## Eksekusi task koding

1. `handleFreeTextInstruction`: pastikan ada project aktif (kalau cuma satu project terdaftar, otomatis dipilih; kalau lebih, tanya lewat picker). Panggil `classifyDepartments` buat dapetin daftar fase, tunjukin rencananya, simpen sebagai `pending_action: confirm_pipeline`, tunggu konfirmasi.
2. User konfirmasi (`ya` = jalan lurus, `ya, checkpoint` = review tiap fase, `tidak`/nggak jelas = batal) → `executeTask` → `queue/taskQueue.enqueueProjectTask`.
3. **Antrian**: serial per-project (task buat project yang sama nunggu task sebelumnya kelar dulu, supaya nggak ada dua sesi agent nulis ke workspace git yang sama bersamaan), paralel penuh lintas-project.
4. `agent/pipeline.ts` → `runPipeline`: fase tunggal `semua` langsung dieksekusi tanpa mesin fase (checkpoint nggak berlaku di sini, nggak ada yang perlu di-pause-in). Multi-fase: tiap fase dapet system prompt yang menyertakan ringkasan fase-fase sebelumnya sebagai konteks (`buildPhaseSystemPrompt`), **cuma fase terakhir** yang boleh commit/merge/push/buka PR — fase-fase sebelumnya cuma nulis kode + kasih ringkasan serah-terima 2-4 baris, biar nggak ada riwayat commit setengah-jadi per fase.
5. Kalau checkpoint aktif dan bukan fase terakhir: pipeline pause, kirim tombol Ya/Tidak/instruksi-revisi lewat WhatsApp, nunggu `resolveCheckpoint`. `continue` → lanjut fase berikut. `revise` → fase yang sama diulang dengan instruksi revisi digabung ke konteks, lalu nanya lagi (bisa berkali-kali). `cancel` → seluruh pipeline berhenti.
6. Tiap fase jalan lewat `agent/loop.ts` (`runAgentLoop`) — loop tool-calling: panggil provider dengan daftar tool, kalau responsnya `tool_calls` eksekusi satu-satu lalu kasih hasilnya balik ke model, ulang sampai model kasih jawaban teks (itu tandanya selesai) atau `maxTurns` habis (40 buat task biasa, 15 per fase pipeline). Kalau provider error, otomatis pindah ke provider/key berikutnya dalam giliran yang sama.

**Tool yang tersedia** (`agent/tools.ts`): `bash` (jalan di working directory project, timeout 5 menit), `read_file`, `write_file`, `edit_file` (replace substring unik), `send_document` (kirim file project sebagai lampiran WhatsApp, cuma kalau diminta eksplisit atau memang itu tujuan tasknya). Ditambah tool `figma_*` secara dinamis kalau instruksinya mengandung link Figma dan akun sudah `hubungkan figma`.

**Proteksi**:
- `resolveWithin` — tiap `read_file`/`write_file`/`edit_file` divalidasi hasil resolve path-nya masih di dalam direktori project; `../` yang keluar dari situ ditolak.
- `isDangerousBashCommand` — pola-pola berbahaya (rm -rf ke root/home/wildcard, download-lalu-eksekusi-ke-shell, chmod 777, sudo, decode base64, reverse shell lewat netcat/`/dev/tcp`, baca file kredensial macam `.env`/`id_rsa`/`.aws/credentials`) memicu `onDangerousBash` — command itu **ditahan**, WhatsApp nanya konfirmasi user (`handlePendingBashApproval`, cuma "ya" eksak yang meloloskan, apa pun selain itu dianggap tolak). Ini heuristik pola teks, **bukan sandbox** — begitu disetujui, command jalan dengan permission penuh proses orchestrator.
- Prompt sistem tiap fase (`systemPrompt.ts`) selalu menyertakan peringatan anti-prompt-injection: apa pun yang dibaca lewat tool (isi file, output command, konten Figma) adalah data buat diperiksa, bukan instruksi buat diikuti — kalau ada teks yang kayak nyoba ngarahkan model ("ignore previous instructions", dst), jangan dituruti, cukup disebut di ringkasan akhir.

## Chat biasa & memori

Kalau `classifyMessageKind` bilang `chat` (bukan task), `handleChatMessage` (`agent/chatAssistant.ts`) yang jalan — beda dari balasan statis di `dynamicReplies.ts` (dipakai buat intro/greeting/help/explain, satu tembakan tanpa histori, cuma digrounding ke fakta tetap yang ditulis di prompt):

- Ambil 12 pesan terakhir dari `chat_history` (tabel di-prune ke maksimal 40 baris per nomor tiap kali nambah baris baru) buat konteks obrolan.
- Ambil sampai 30 fakta terakhir dari `user_memory` (permanen, lintas sesi — beda dari `chat_history` yang cuma histori pendek) buat digrounding ke prompt.
- Satu panggilan AI ngerjain dua hal sekaligus: kasih balasan natural, **dan** di baris terakhir opsional nyebutin satu fakta baru yang layak diinget (`FACT: ...` atau `FACT: tidak ada`) — sengaja satu panggilan, bukan dua, biar nggak dobel biaya tiap pesan obrolan.
- User bisa `lihat memori` (tampilin semua fakta tersimpan) atau `lupain semua` (hapus semua, minta konfirmasi dulu — ini permanen).

## Registrasi project & git

`registerGitProject` → `git/repo.ts` `ensureWorkspace`: clone (kalau belum ada `.git` di `workspaces/<alias>`), lalu **deteksi branch default sebenarnya** dari `refs/remotes/origin/HEAD` (bukan asumsi `"main"` — repo yang default branch-nya beda, misal `master`, atau yang masih kosong sama sekali tanpa commit, dulu gagal dengan error git mentah yang kekirim langsung ke WhatsApp; sekarang dideteksi dan kalau beda dari yang tersimpan di DB, tabel `projects` di-self-heal). Kalau registrasi gagal di tengah jalan, baris project yang kadung dibikin di-rollback (dihapus) — supaya user bisa coba lagi tanpa kejebak status "udah ada" padahal clone-nya nggak pernah beres.

Kredensial GitHub **nggak pernah** disimpen di URL remote atau di disk — `ensureGithubCredentialHelper` masang git credential helper global (`git config --global credential.https://github.com.helper`) yang baca `GITHUB_TOKEN` langsung dari environment proses saat diminta git, di-scope ke host `github.com` doang. `isAllowedRepoUrl` (`router/parse.ts`) cuma menerima `https://github.com/<owner>/<repo>` persis — nolak transport helper git kayak `ext::sh -c ...` (RCE lewat clone) dan host selain github.com (yang kalau lolos bakal ditawarin kredensial GitHub kita pas fetch).

## Keamanan — ringkasan

- **`ALLOWED_SENDERS`** dicek dua kali: di gateway (drop sebelum forward) dan di orchestrator (403 kalau lolos gateway tapi nggak allowlisted — jaga-jaga endpoint internal dipanggil dari jalur lain).
- **`X-Internal-Secret`** wajib di tiap panggilan gateway↔orchestrator.
- **HMAC signature** wajib buat tiap webhook dari Meta.
- **`isAllowedRepoUrl`** & **credential helper** — lihat bagian di atas.
- **`isDangerousBashCommand`** + persetujuan WhatsApp — lihat bagian Eksekusi task.
- **Peringatan anti-prompt-injection** di tiap system prompt fase.
- **`audit_log`** — tiap tool call, progress note, error dicatat per `task_id`, jadi jejak audit apa yang sebenarnya dikerjakan agent secara otonom.
- Batas ukuran per endpoint: `/inbound` 8MB (gambar base64), `/send-document` 20MB (dokumen base64), gambar masuk maks 5MB, dokumen keluar maks 16MB — semuanya di-scope per-route, bukan limit global.

## Skema database (SQLite, `better-sqlite3`)

| Tabel | Isi |
|---|---|
| `projects` | Project terdaftar — alias, remote/path, default branch, mode auto-merge, git atau folder lokal. |
| `tasks` | Satu baris per eksekusi task dan hasilnya. |
| `audit_log` | Jejak tiap tool call/note/error per task. |
| `conversation_state` | State per nomor WhatsApp — project aktif, `pending_action`, provider pilihan. |
| `figma_oauth` | Token OAuth Figma (single-tenant, satu baris). |
| `user_memory` | Fakta permanen lintas sesi soal tiap user. |
| `chat_history` | Histori obrolan biasa terbaru (bukan task), dipangkas otomatis. |
