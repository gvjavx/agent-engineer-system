import express from "express";
import { config } from "./config.js";
import {
  extractInboundMessages,
  sendWhatsAppMessage,
  sendWhatsAppOptions,
  verifySignature,
  type QuickReplyOption,
} from "./whatsapp.js";
import { forwardToOrchestrator, forwardFigmaOAuthCallback } from "./orchestratorClient.js";

const app = express();

// Meta signs the raw body, so we need it verbatim before JSON parsing kicks in.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: Buffer }).rawBody = buf;
    },
  })
);

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

// Step 2: Meta POSTs inbound messages/events here.
app.post("/webhook", async (req, res) => {
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
    try {
      await forwardToOrchestrator(message);
    } catch (err) {
      console.error("Failed to forward inbound message to orchestrator:", err);
      await sendWhatsAppMessage(
        message.from,
        "Waduh, pesannya gagal kekirim ke sistem. Coba kirim lagi ya sebentar."
      ).catch(() => {});
    }
  }
});

// Internal endpoint: orchestrator calls this to send a reply/progress update,
// optionally as tappable quick-reply buttons/list instead of plain text.
app.post("/send", async (req, res) => {
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
