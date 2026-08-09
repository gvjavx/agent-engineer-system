import express from "express";
import { config } from "./config.js";
import { handleInboundMessage } from "./router/handler.js";
import { exchangeCodeForTokens } from "./agent/mcp/figmaAuth.js";
import { consumePendingState } from "./agent/mcp/figmaOAuthState.js";
import { sendWhatsApp } from "./whatsappClient.js";
import "./db/index.js";

const app = express();
app.use(express.json());

app.post("/inbound", (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { from, text } = req.body as { from?: string; text?: string };
  if (!from || !text) {
    return res.status(400).json({ error: "Missing 'from' or 'text'" });
  }

  // Ack immediately; the actual work (cloning, running the agent) can take
  // minutes and is reported back to WhatsApp asynchronously as it progresses.
  res.sendStatus(202);

  handleInboundMessage(from, text).catch((err) => {
    console.error(`Unhandled error handling message from ${from}:`, err);
  });
});

// Called by whatsapp-gateway (the only publicly reachable piece) once the
// user finishes Figma's OAuth consent screen and gets redirected back.
app.post("/internal/figma-oauth-callback", (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { code, state } = req.body as { code?: string; state?: string };
  if (!code || !state) {
    return res.status(400).json({ error: "Missing 'code' or 'state'" });
  }
  res.sendStatus(202);

  const fromNumber = consumePendingState(state);
  if (!fromNumber) {
    console.error("Figma OAuth callback with an unknown or expired state");
    return;
  }

  exchangeCodeForTokens(code)
    .then(() => sendWhatsApp(fromNumber, "Figma udah kesambung! Tinggal tempel link Figma-nya di instruksi kamu."))
    .catch((err) =>
      sendWhatsApp(fromNumber, `Gagal nyambungin Figma: ${err instanceof Error ? err.message : String(err)}`)
    );
});

app.get("/healthz", (_req, res) => res.sendStatus(200));

app.listen(config.port, () => {
  console.log(`orchestrator listening on port ${config.port}`);
});
