import express from "express";
import { config } from "./config.js";
import {
  extractInboundMessages,
  sendWhatsAppMessage,
  sendWhatsAppOptions,
  uploadMedia,
  sendWhatsAppDocument,
  sendWhatsAppAudio,
  sendWhatsAppImage,
  downloadMedia,
  verifySignature,
  markReadAndShowTyping,
  type QuickReplyOption,
} from "./whatsapp.js";
import { isAllowedInboundImageMimeType, MAX_INBOUND_IMAGE_BYTES } from "./imageGuard.js";
import { isAllowedInboundAudioMimeType, MAX_INBOUND_AUDIO_BYTES } from "./audioGuard.js";
import { forwardToOrchestrator, forwardFigmaOAuthCallback } from "./orchestratorClient.js";

const app = express();

// No blanket app.use(express.json()) — each route gets its own parser sized
// (and, for /webhook, raw-body-capturing) for what it actually needs, so a
// bigger limit on one route doesn't quietly widen every other route too.

// Step 1 of Meta webhook setup: they GET this URL with a challenge to confirm ownership.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.metaVerifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Step 2: Meta POSTs inbound messages/events here. Meta signs the raw body,
// so we need it verbatim before JSON parsing kicks in.
app.post(
  "/webhook",
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: Buffer }).rawBody = buf;
    },
  }),
  async (req, res) => {
    const rawBody = (req as express.Request & { rawBody: Buffer }).rawBody;
    const signature = req.header("X-Hub-Signature-256");

    if (!verifySignature(rawBody, signature)) {
      console.warn("Rejected webhook with invalid signature");
      return res.sendStatus(401);
    }

    // Ack immediately; Meta retries aggressively if we're slow or if it 4xx/5xxs.
    res.sendStatus(200);

    const messages = extractInboundMessages(req.body);
    for (const message of messages) {
      const senderAllowed = config.allowedSenders.includes(message.from);
      if (!senderAllowed) {
        console.warn(`Ignoring message from non-allowlisted sender: ${message.from}`);
        continue;
      }

      // Fire-and-forget, not awaited — this is what the user actually sees
      // *while* the (often multi-second, sometimes AI-classifier-heavy) work
      // below happens; blocking on it here would just delay that work by
      // exactly the latency this is trying to hide.
      markReadAndShowTyping(message.waMessageId);

      let image: { mimeType: string; base64Data: string } | undefined;
      if (message.imageId) {
        if (!message.imageMimeType || !isAllowedInboundImageMimeType(message.imageMimeType)) {
          await sendWhatsAppMessage(
            message.from,
            "Format gambarnya belum aku dukung (cuma JPEG/PNG). Coba kirim format lain ya."
          ).catch(() => {});
          continue;
        }
        try {
          const downloaded = await downloadMedia(message.imageId);
          if (!isAllowedInboundImageMimeType(downloaded.mimeType)) {
            await sendWhatsAppMessage(
              message.from,
              "Format gambarnya belum aku dukung (cuma JPEG/PNG). Coba kirim format lain ya."
            ).catch(() => {});
            continue;
          }
          if (downloaded.buffer.length > MAX_INBOUND_IMAGE_BYTES) {
            await sendWhatsAppMessage(
              message.from,
              `Gambarnya kegedean (maks ${MAX_INBOUND_IMAGE_BYTES / 1024 / 1024}MB). Coba kompres dulu.`
            ).catch(() => {});
            continue;
          }
          image = { mimeType: downloaded.mimeType, base64Data: downloaded.buffer.toString("base64") };
        } catch (err) {
          console.error("Failed to download inbound image:", err);
          await sendWhatsAppMessage(
            message.from,
            "Waduh, gagal ambil gambarnya dari WhatsApp. Coba kirim ulang ya."
          ).catch(() => {});
          continue;
        }
      }

      let audio: { mimeType: string; base64Data: string } | undefined;
      if (message.audioId) {
        try {
          const downloaded = await downloadMedia(message.audioId);
          if (!isAllowedInboundAudioMimeType(downloaded.mimeType)) {
            await sendWhatsAppMessage(
              message.from,
              "Format audionya belum aku dukung. Coba kirim sebagai voice note biasa, atau ketik aja."
            ).catch(() => {});
            continue;
          }
          if (downloaded.buffer.length > MAX_INBOUND_AUDIO_BYTES) {
            await sendWhatsAppMessage(
              message.from,
              `Voice note-nya kegedean (maks ${MAX_INBOUND_AUDIO_BYTES / 1024 / 1024}MB). Coba yang lebih pendek.`
            ).catch(() => {});
            continue;
          }
          audio = { mimeType: downloaded.mimeType, base64Data: downloaded.buffer.toString("base64") };
        } catch (err) {
          console.error("Failed to download inbound audio:", err);
          await sendWhatsAppMessage(
            message.from,
            "Waduh, gagal ambil voice note-nya dari WhatsApp. Coba kirim ulang ya."
          ).catch(() => {});
          continue;
        }
      }

      try {
        await forwardToOrchestrator(message, image, audio);
      } catch (err) {
        console.error("Failed to forward inbound message to orchestrator:", err);
        await sendWhatsAppMessage(
          message.from,
          "Waduh, pesannya gagal kekirim ke sistem. Coba kirim lagi ya sebentar."
        ).catch(() => {});
      }
    }
  }
);

// Internal endpoint: orchestrator calls this to send a reply/progress update,
// optionally as tappable quick-reply buttons/list instead of plain text.
app.post("/send", express.json(), async (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { to, text, options, listButtonLabel } = req.body as {
    to?: string;
    text?: string;
    options?: QuickReplyOption[];
    listButtonLabel?: string;
  };
  if (!to || !text) {
    return res.status(400).json({ error: "Missing 'to' or 'text'" });
  }
  try {
    if (options && options.length > 0) {
      await sendWhatsAppOptions(to, text, options, listButtonLabel);
    } else {
      await sendWhatsAppMessage(to, text);
    }
    res.sendStatus(204);
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err);
    res.status(502).json({ error: "Failed to send WhatsApp message" });
  }
});

// Internal endpoint: orchestrator calls this when the agent wants to deliver
// a file as a WhatsApp document attachment. Bigger body limit than the other
// routes since the file comes over as base64 — scoped to just this route.
app.post("/send-document", express.json({ limit: "20mb" }), async (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { to, filename, mimeType, caption, contentBase64 } = req.body as {
    to?: string;
    filename?: string;
    mimeType?: string;
    caption?: string;
    contentBase64?: string;
  };
  if (!to || !filename || !mimeType || !contentBase64) {
    return res.status(400).json({ error: "Missing 'to', 'filename', 'mimeType', or 'contentBase64'" });
  }
  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const mediaId = await uploadMedia(buffer, filename, mimeType);
    await sendWhatsAppDocument(to, mediaId, filename, caption);
    res.sendStatus(204);
  } catch (err) {
    console.error("Failed to send WhatsApp document:", err);
    res.status(502).json({ error: "Failed to send WhatsApp document" });
  }
});

// Internal endpoint: orchestrator calls this to reply with a voice note
// (opt-in, only right after the user sent one). MP3 bytes come over as base64.
app.post("/send-audio", express.json({ limit: "10mb" }), async (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { to, mp3Base64 } = req.body as { to?: string; mp3Base64?: string };
  if (!to || !mp3Base64) {
    return res.status(400).json({ error: "Missing 'to' or 'mp3Base64'" });
  }
  try {
    const mediaId = await uploadMedia(Buffer.from(mp3Base64, "base64"), "reply.mp3", "audio/mpeg");
    await sendWhatsAppAudio(to, mediaId);
    res.sendStatus(204);
  } catch (err) {
    console.error("Failed to send WhatsApp audio:", err);
    res.status(502).json({ error: "Failed to send WhatsApp audio" });
  }
});

// Internal endpoint: orchestrator calls this to send an image (currently the
// "screenshot" command's PNG). Bytes come over as base64.
app.post("/send-image", express.json({ limit: "20mb" }), async (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { to, pngBase64, caption } = req.body as { to?: string; pngBase64?: string; caption?: string };
  if (!to || !pngBase64) {
    return res.status(400).json({ error: "Missing 'to' or 'pngBase64'" });
  }
  try {
    const mediaId = await uploadMedia(Buffer.from(pngBase64, "base64"), "screenshot.png", "image/png");
    await sendWhatsAppImage(to, mediaId, caption);
    res.sendStatus(204);
  } catch (err) {
    console.error("Failed to send WhatsApp image:", err);
    res.status(502).json({ error: "Failed to send WhatsApp image" });
  }
});

// Figma redirects the user's browser here after they approve/deny the OAuth
// consent screen. This is the only publicly reachable piece of the system,
// so it just forwards code+state to the orchestrator and shows a plain page.
app.get("/figma/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  if (typeof code !== "string" || typeof state !== "string") {
    res.status(400).send("Gagal sambungin Figma (link ditolak atau kadaluarsa). Coba \"hubungkan figma\" lagi dari WhatsApp.");
    return;
  }
  try {
    await forwardFigmaOAuthCallback(code, state);
    res.send("Berhasil! Boleh tutup tab ini, nanti dikabarin lewat WhatsApp.");
  } catch (err) {
    console.error("Failed to forward Figma OAuth callback:", err);
    res.status(502).send("Gagal nyambungin ke sistem. Coba \"hubungkan figma\" lagi dari WhatsApp.");
  }
});

app.get("/healthz", (_req, res) => res.sendStatus(200));

app.listen(config.port, () => {
  console.log(`whatsapp-gateway listening on port ${config.port}`);
});
