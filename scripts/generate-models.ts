import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEEPINFRA_MODELS_URL = "https://opencode.ai/zen/v1/models";

const ALLOWED_MODELS = new Set([
  "mimo-v2.5-free",
  "x-preview-f-free",
  "hy3-free",
  "nemotron-3.5-lightning-free"
]);

function hash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

function gatewayModelId(deepinfraId: string): string {
  return `anthropic/claude-gateway-${hash(deepinfraId)}`;
}

async function main() {
  const response = await fetch(DEEPINFRA_MODELS_URL);

  if (!response.ok) {
    throw new Error(`DeepInfra models fetch failed: ${response.status}`);
  }

  const payload = (await response.json()) as { data?: { id: string }[] };

  const models: Record<string, { id: string; name: string }> = {};
  for (const model of payload.data ?? []) {
    if (ALLOWED_MODELS.size > 0 && !ALLOWED_MODELS.has(model.id)) continue;
    models[gatewayModelId(model.id)] = { id: model.id, name: model.id };
  }

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "api",
    "anthropic",
    "v1",
    "generated-models.json",
  );

  await writeFile(outPath, JSON.stringify(models, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(models).length} models to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
