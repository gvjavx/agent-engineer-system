import express from "express";
import { config } from "./config.js";
import { handleInboundMessage } from "./router/handler.js";
import { exchangeCodeForTokens } from "./agent/mcp/figmaAuth.js";
import { consumePendingState } from "./agent/mcp/figmaOAuthState.js";
import { sendWhatsApp } from "./whatsappClient.js";
import { startIdleSessionScanner } from "./session/idleNotifier.js";
import { isDuplicateInboundMessage } from "./inboundDedup.js";
import { tasksRepo } from "./db/index.js";
import { warmLocalEmbedder } from "./agent/localEmbedder.js";
import { warmLocalLlm } from "./agent/localLlm.js";

const app = express();

// No blanket app.use(express.json()) — each route gets its own parser sized
// for what it actually needs, same principle as whatsapp-gateway/src/index.ts.

app.post("/inbound", express.json({ limit: "8mb" }), (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { from, text, image, waMessageId } = req.body as {
    from?: string;
    text?: string;
    image?: { mimeType?: string; base64Data?: string };
    waMessageId?: string;
  };
  // text === "" is valid and expected for a captionless image — only reject
  // when there's neither text nor an image at all.
  if (!from || (!image && !text)) {
    return res.status(400).json({ error: "Missing 'from', or missing both 'text' and 'image'" });
  }
  // Belt-and-suspenders: whatsapp-gateway already filters by ALLOWED_SENDERS
  // before forwarding, but this endpoint shouldn't blindly trust every caller
  // that knows the internal secret to have applied that filter correctly.
  if (!config.allowedSenders.includes(from)) {
    console.warn(`Rejecting /inbound from non-allowlisted sender: ${from}`);
    return res.sendStatus(403);
  }

  // Ack immediately; the actual work (cloning, running the agent) can take
  // minutes and is reported back to WhatsApp asynchronously as it progresses.
  res.sendStatus(202);

  // See inboundDedup.ts — a retried delivery of a message we already started
  // handling must be a no-op, not a second independent run.
  if (waMessageId && isDuplicateInboundMessage(waMessageId)) {
    console.warn(`Ignoring duplicate delivery of ${waMessageId} from ${from}`);
    return;
  }

  const validImage =
    image?.mimeType && image?.base64Data ? { mimeType: image.mimeType, base64Data: image.base64Data } : undefined;
  handleInboundMessage(from, text ?? "", validImage).catch((err) => {
    console.error(`Unhandled error handling message from ${from}:`, err);
  });
});

// Called by whatsapp-gateway (the only publicly reachable piece) once the
// user finishes Figma's OAuth consent screen and gets redirected back.
app.post("/internal/figma-oauth-callback", express.json(), (req, res) => {
  if (req.header("X-Internal-Secret") !== config.internalSharedSecret) {
    return res.sendStatus(401);
  }
  const { code, state } = req.body as { code?: string; state?: string };
  if (!code || !state) {
    return res.status(400).json({ error: "Missing 'code' or 'state'" });
  }
  res.sendStatus(202);

  const resolved = consumePendingState(state);
  if (!resolved) {
    console.error("Figma OAuth callback with an unknown or expired state");
    return;
  }
  const { fromNumber, codeVerifier } = resolved;

  exchangeCodeForTokens(code, codeVerifier)
    .then(() => sendWhatsApp(fromNumber, "Figma udah kesambung! Tinggal tempel link Figma-nya di instruksi kamu."))
    .catch((err) =>
      sendWhatsApp(fromNumber, `Gagal nyambungin Figma: ${err instanceof Error ? err.message : String(err)}`)
    );
});

app.get("/healthz", (_req, res) => res.sendStatus(200));

// Before accepting any request — anything still 'queued'/'running' at this
// point belongs to a process that no longer exists (see
// tasksRepo.recoverOrphaned's comment). No WhatsApp notification: these are
// stale bookkeeping fixes, not something worth surfacing for tasks that may
// be long past relevant to the user.
const recovered = tasksRepo.recoverOrphaned();
if (recovered.length > 0) {
  console.warn(
    `Recovered ${recovered.length} task(s) stuck from a previous run: ${recovered.map((t) => t.id).join(", ")}`
  );
}

app.listen(config.port, () => {
  console.log(`orchestrator listening on port ${config.port}`);
  startIdleSessionScanner();
  // Load the local models in the background so the first request isn't the
  // one that pays the load cost.
  if (config.chatKb.semanticFallback || config.rag.enabled) warmLocalEmbedder();
  if (config.localLlm.enabled) warmLocalLlm();
});
