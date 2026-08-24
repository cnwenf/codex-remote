import { delimiter, join } from "node:path";

const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

export function resolveCodexBinary(
  env: { CODEX_BIN?: string; PATH?: string } = {
    CODEX_BIN: process.env.CODEX_BIN,
    PATH: process.env.PATH,
  },
  pathExists: (path: string) => boolean,
): string {
  if (env.CODEX_BIN) {
    if (!pathExists(env.CODEX_BIN)) {
      throw new Error("configured-codex-binary-not-found");
    }
    return env.CODEX_BIN;
  }

  for (const directory of env.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, "codex");
    if (pathExists(candidate)) return candidate;
  }

  if (pathExists(BUNDLED_CODEX)) return BUNDLED_CODEX;
  throw new Error("codex-binary-not-found");
}
