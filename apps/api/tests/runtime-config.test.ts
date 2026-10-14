import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeEnvironment, resolveRuntimeEnvPath } from "../src/runtime-config.js";

const originalConfigPath = process.env.DOTENV_CONFIG_PATH;
const originalProbe = process.env.INSPECTION_ENV_PROBE;

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
  else process.env.DOTENV_CONFIG_PATH = originalConfigPath;

  if (originalProbe === undefined) delete process.env.INSPECTION_ENV_PROBE;
  else process.env.INSPECTION_ENV_PROBE = originalProbe;
});

describe("runtime environment configuration", () => {
  it("resolves the project root .env independently of the process working directory", () => {
    const expected = fileURLToPath(new URL("../../../.env", import.meta.url));
    expect(resolveRuntimeEnvPath()).toBe(expected);
  });

  it("supports an explicit DOTENV_CONFIG_PATH override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspection-env-"));
    const envPath = join(directory, "runtime.env");

    try {
      await writeFile(envPath, "INSPECTION_ENV_PROBE=loaded-from-override\n", "utf8");
      process.env.DOTENV_CONFIG_PATH = envPath;
      delete process.env.INSPECTION_ENV_PROBE;

      const result = loadRuntimeEnvironment();

      expect(result.error).toBeUndefined();
      expect(process.env.INSPECTION_ENV_PROBE).toBe("loaded-from-override");
      expect(resolveRuntimeEnvPath()).toBe(resolve(envPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
