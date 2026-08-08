import express from "express";
import { config } from "./config.js";
import { extractInboundMessages, sendWhatsAppMessage, verifySignature } from "./whatsapp.js";
import { forwardToOrchestrator } from "./orchestratorClient.js";

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
        "⚠️ Gagal meneruskan pesan ke orchestrator. Coba lagi sebentar."
      ).catch(() => {});
    }
  }
});

// Internal endpoint: orchestrator calls this to send a reply/progress update.
app.post("/send", async (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { to, text } = req.body as { to?: string; text?: string };
  if (!to || !text) {
    return res.status(400).json({ error: "Missing 'to' or 'text'" });
  }
  try {
    await sendWhatsAppMessage(to, text);
    res.sendStatus(204);
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err);
    res.status(502).json({ error: "Failed to send WhatsApp message" });
  }
});

app.get("/healthz", (_req, res) => res.sendStatus(200));

app.listen(config.port, () => {
  console.log(`whatsapp-gateway listening on port ${config.port}`);
});
