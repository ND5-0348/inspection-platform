import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, type DotenvConfigOutput } from "dotenv";

export function resolveRuntimeEnvPath(
  moduleUrl = import.meta.url,
  overridePath = process.env.DOTENV_CONFIG_PATH,
): string {
  if (overridePath) return resolve(overridePath);
  return fileURLToPath(new URL("../../../.env", moduleUrl));
}

export function loadRuntimeEnvironment(): DotenvConfigOutput {
  return config({ path: resolveRuntimeEnvPath(), quiet: true });
}
