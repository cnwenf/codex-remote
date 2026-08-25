import type { MobileStatusResponse, MobileTask, MobileTaskStatus } from "../mobile/types";

const MAX_MOBILE_THREADS = 100;
const MAX_MOBILE_TITLE = 160;

export function projectMobileStatus(
  value: unknown,
  generatedAt = Date.now(),
  statusOverrides: ReadonlyMap<string, MobileTaskStatus> = new Map(),
): MobileStatusResponse {
  const data = asRecord(value).data;
  const threads = Array.isArray(data)
    ? data.slice(0, MAX_MOBILE_THREADS).flatMap<MobileTask>((entry) => {
        const record = asRecord(entry);
        const id = stringValue(record.id);
        if (!id) return [];
        const title = (
          stringValue(record.title) ??
          stringValue(record.name) ??
          "Untitled task"
        ).slice(0, MAX_MOBILE_TITLE);
        const updatedAt = numberValue(record.updatedAt) ?? numberValue(record.updated_at);
        return [{
          id,
          title,
          status: statusOverrides.get(id) ?? normalizeMobileStatus(record.status),
          ...(updatedAt === undefined ? {} : { updatedAt }),
        }];
      })
    : [];
  return { version: 1, generatedAt, threads };
}

function normalizeMobileStatus(value: unknown): MobileTaskStatus {
  const raw = typeof value === "string" ? value : stringValue(asRecord(value).type);
  if (raw === "running" || raw === "active") return "running";
  if (raw === "idle" || raw === "completed" || raw === "notLoaded") return "idle";
  if (raw === "error" || raw === "failed" || raw === "systemError") return "error";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
