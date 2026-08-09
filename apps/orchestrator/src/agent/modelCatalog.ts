import OpenAI from "openai";

// Model names that technically support generateContent but aren't meant for
// general text/agentic chat (TTS, image generation, embeddings, robotics,
// research-agent variants, etc.) — filtered out so "daftar model" doesn't
// drown the handful of usable chat models in noise.
const NON_CHAT_MODEL_PATTERN = /tts|image|embedding|robotics|lyria|aqa|nano-banana|deep-research|computer-use/i;

export async function listGeminiModels(apiKey: string, query: string): Promise<string[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!res.ok) {
    throw new Error(`Gagal ambil daftar model Gemini (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  const lowerQuery = query.toLowerCase();
  return (data.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((name) => !NON_CHAT_MODEL_PATTERN.test(name))
    .filter((name) => name.toLowerCase().includes(lowerQuery));
}

export async function listOpenAiCompatibleModels(baseURL: string, apiKey: string, query: string): Promise<string[]> {
  const client = new OpenAI({ apiKey, baseURL });
  const lowerQuery = query.toLowerCase();
  const matches: string[] = [];
  for await (const model of client.models.list()) {
    if (model.id.toLowerCase().includes(lowerQuery)) matches.push(model.id);
  }
  return matches;
}
