import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type IsProcessAlive = (pid: number) => boolean;

export function acquireDesktopBridgeLock(
  path: string,
  pid = process.pid,
  isProcessAlive: IsProcessAlive = defaultIsProcessAlive,
) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${pid}\n`, "utf8");
      closeSync(descriptor);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            if (readLockPid(path) === pid) unlinkSync(path);
          } catch {
            // The owner may have already cleaned up during shutdown.
          }
        },
      };
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      const ownerPid = readLockPid(path);
      if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
        throw new Error(`desktop-bridge-already-owned:${ownerPid}`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkCause) {
        if (!isMissing(unlinkCause)) throw unlinkCause;
      }
    }
  }
  throw new Error("desktop-bridge-lock-unavailable");
}

function readLockPid(path: string) {
  const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function defaultIsProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return isPermissionDenied(cause);
  }
}

function isAlreadyExists(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

function isMissing(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isPermissionDenied(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "EPERM";
}
