import express from "express";
import { config } from "./config.js";
import { handleInboundMessage } from "./router/handler.js";
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

app.get("/healthz", (_req, res) => res.sendStatus(200));

app.listen(config.port, () => {
  console.log(`orchestrator listening on port ${config.port}`);
});
