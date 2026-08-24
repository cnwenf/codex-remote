export type PermissionState = {
  permission?: string;
  permissionProfile?: string;
  approvalPolicy?: unknown;
  approvalsReviewer?: string;
  sandboxPolicy?: unknown;
};

export type PermissionModeVisibility = {
  guardianApprovals?: boolean;
  fullAccess?: boolean;
};

export type PermissionModeOption = {
  id: string;
  label: string;
  description?: string;
};

const REQUEST_APPROVAL: PermissionModeOption = {
  id: "auto",
  label: "请求批准",
  description: "编辑外部文件和使用互联网时始终询问",
};

const GUARDIAN_APPROVAL: PermissionModeOption = {
  id: "guardian-approvals",
  label: "帮我批准",
  description: "仅对检测到的风险操作请求批准",
};

const FULL_ACCESS: PermissionModeOption = {
  id: "full-access",
  label: "完全访问权限",
  description: "可不受限制地访问互联网和你电脑上的任何文件",
};

export function permissionModeOptions(
  profilesValue: unknown,
  visibility: PermissionModeVisibility = { guardianApprovals: true, fullAccess: true },
): PermissionModeOption[] {
  const data = asRecord(profilesValue).data;
  if (!Array.isArray(data)) return [];
  const profiles = data.flatMap((entry) => {
    const record = asRecord(entry);
    const id = stringValue(record.id);
    return id && record.allowed !== false
      ? [{ id, description: stringValue(record.description) }]
      : [];
  });
  const ids = new Set(profiles.map((profile) => profile.id));
  const result: PermissionModeOption[] = [];
  if (ids.has(":workspace") || ids.has(":read-only")) {
    result.push(REQUEST_APPROVAL);
    if (ids.has(":workspace") && visibility.guardianApprovals !== false) {
      result.push(GUARDIAN_APPROVAL);
    }
  }
  if (ids.has(":danger-full-access") && visibility.fullAccess !== false) {
    result.push(FULL_ACCESS);
  }
  for (const profile of profiles) {
    if (profile.id === ":workspace" || profile.id === ":read-only" || profile.id === ":danger-full-access") {
      continue;
    }
    result.push({
      id: profile.id,
      label: profile.id.replace(/^:/, ""),
      description: profile.description,
    });
  }
  return result;
}

export function permissionStateFromProtocol(
  value: unknown,
  fallback: PermissionState = {},
): PermissionState {
  const record = asRecord(value);
  const hasProfile = Object.hasOwn(record, "activePermissionProfile");
  const profile = hasProfile
    ? stringValue(asRecord(record.activePermissionProfile).id)
    : fallback.permissionProfile;
  const hasSandbox = Object.hasOwn(record, "sandboxPolicy") || Object.hasOwn(record, "sandbox");
  const sandboxPolicy = hasSandbox
    ? record.sandboxPolicy ?? record.sandbox
    : fallback.sandboxPolicy;
  const approvalPolicy = Object.hasOwn(record, "approvalPolicy")
    ? record.approvalPolicy
    : fallback.approvalPolicy;
  const approvalsReviewer = Object.hasOwn(record, "approvalsReviewer")
    ? stringValue(record.approvalsReviewer)
    : fallback.approvalsReviewer;
  return {
    permission: inferPermissionMode({
      permissionProfile: profile,
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy,
    }) ?? fallback.permission,
    permissionProfile: profile,
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy,
  };
}

export function permissionStateForMode(mode: string): PermissionState {
  if (mode === "auto") {
    return {
      permission: mode,
      permissionProfile: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite" },
    };
  }
  if (mode === "guardian-approvals") {
    return {
      permission: mode,
      permissionProfile: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: { type: "workspaceWrite" },
    };
  }
  if (mode === "full-access") {
    return {
      permission: mode,
      permissionProfile: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  return { permission: mode, permissionProfile: mode };
}

export function permissionRpcParamsForMode(mode: string): Record<string, unknown> {
  const state = permissionStateForMode(mode);
  return {
    ...(state.permissionProfile ? { permissions: state.permissionProfile } : {}),
    ...(state.approvalPolicy !== undefined ? { approvalPolicy: state.approvalPolicy } : {}),
    ...(state.approvalsReviewer ? { approvalsReviewer: state.approvalsReviewer } : {}),
  };
}

export function permissionRpcParamsFromState(state: PermissionState): Record<string, unknown> {
  if (!state.permissionProfile && state.permission) {
    return permissionRpcParamsForMode(state.permission);
  }
  return {
    ...(state.permissionProfile ? { permissions: state.permissionProfile } : {}),
    ...(state.approvalPolicy !== undefined ? { approvalPolicy: state.approvalPolicy } : {}),
    ...(state.approvalsReviewer ? { approvalsReviewer: state.approvalsReviewer } : {}),
    ...(!state.permissionProfile && state.sandboxPolicy !== undefined
      ? { sandboxPolicy: state.sandboxPolicy }
      : {}),
  };
}

function inferPermissionMode(state: PermissionState) {
  const sandboxType = stringValue(asRecord(state.sandboxPolicy).type);
  const danger = state.permissionProfile === ":danger-full-access" ||
    sandboxType === "dangerFullAccess" || sandboxType === "danger-full-access" ||
    sandboxType === "disabled";
  const workspace = state.permissionProfile === ":workspace" ||
    sandboxType === "workspaceWrite" || sandboxType === "workspace-write";
  const readOnly = state.permissionProfile === ":read-only" ||
    sandboxType === "readOnly" || sandboxType === "read-only";
  const automaticReviewer = state.approvalsReviewer === "guardian_subagent" ||
    state.approvalsReviewer === "auto_review";
  if (danger && state.approvalPolicy === "never") return "full-access";
  if (workspace && state.approvalPolicy === "on-request" && automaticReviewer) {
    return "guardian-approvals";
  }
  if ((workspace || readOnly) && (
    state.approvalPolicy === "on-request" ||
    Boolean(asRecord(state.approvalPolicy).granular)
  )) return "auto";
  return state.permissionProfile;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
