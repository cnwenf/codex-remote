export const MINIMUM_DESKTOP_APP_SERVER_VERSION = "0.141.0";

const CLIENT_METHODS = Object.freeze([
  "initialize",
  "model/list",
  "permissionProfile/list",
  "thread/list",
  "thread/search",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "thread/name/set",
  "thread/metadata/update",
  "thread/settings/update",
  "thread/section/move",
  "thread/rollback",
  "thread/compact/start",
  "thread/fork",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
  "threadSection/list",
  "threadSection/create",
  "threadSection/update",
  "threadSection/delete",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "desktop/listPinnedThreads",
  "desktop/setThreadPinned",
  "desktop/setPinnedThreadsOrder",
] as const);

const SERVER_REQUESTS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
] as const);

export type ProtocolCapabilities = {
  appServerVersion: string;
  minimumVersion: string;
  compatible: boolean;
  reason?: "app-server-version-invalid" | "app-server-version-unsupported";
  clientMethods: string[];
  serverRequests: string[];
};

export function createProtocolCapabilities(appServerVersion: string): ProtocolCapabilities {
  let comparison: number;
  try {
    comparison = compareProtocolVersions(
      appServerVersion,
      MINIMUM_DESKTOP_APP_SERVER_VERSION,
    );
  } catch {
    return incompatible(appServerVersion, "app-server-version-invalid");
  }
  if (comparison < 0) {
    return incompatible(appServerVersion, "app-server-version-unsupported");
  }
  return {
    appServerVersion,
    minimumVersion: MINIMUM_DESKTOP_APP_SERVER_VERSION,
    compatible: true,
    clientMethods: [...CLIENT_METHODS],
    serverRequests: [...SERVER_REQUESTS],
  };
}

export function isAllowedClientMethod(
  capabilities: ProtocolCapabilities,
  method: string,
): boolean {
  return capabilities.compatible && capabilities.clientMethods.includes(method);
}

export function isSupportedServerRequest(
  capabilities: ProtocolCapabilities,
  method: string,
): boolean {
  return capabilities.compatible && capabilities.serverRequests.includes(method);
}

export function compareProtocolVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index] - b.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aValue = a.prerelease[index];
    const bValue = b.prerelease[index];
    if (aValue === undefined) return -1;
    if (bValue === undefined) return 1;
    if (aValue === bValue) continue;
    const aNumber = Number(aValue);
    const bNumber = Number(bValue);
    const aNumeric = Number.isInteger(aNumber) && String(aNumber) === aValue;
    const bNumeric = Number.isInteger(bNumber) && String(bNumber) === bValue;
    if (aNumeric && bNumeric) return Math.sign(aNumber - bNumber);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aValue < bValue ? -1 : 1;
  }
  return 0;
}

function incompatible(
  appServerVersion: string,
  reason: ProtocolCapabilities["reason"],
): ProtocolCapabilities {
  return {
    appServerVersion,
    minimumVersion: MINIMUM_DESKTOP_APP_SERVER_VERSION,
    compatible: false,
    reason,
    clientMethods: [],
    serverRequests: [],
  };
}

function parseVersion(value: string) {
  const match = value.trim().match(
    /^(?:codex[- ]?)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) throw new Error("invalid-protocol-version");
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
    prerelease: match[4]?.split(".") ?? [],
  };
}
