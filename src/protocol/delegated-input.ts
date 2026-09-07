export function delegatedInputFromProtocol(item: Record<string, unknown>) {
  if (typeof item.type !== "string" || item.type.replace(/[_-]/g, "").toLowerCase() !== "functioncalloutput" ||
    item.namespace !== "codex_app" || item.name !== "send_message_to_thread" ||
    item.call_id !== undefined || item.callId !== undefined || typeof item.id !== "string" ||
    !item.id.trim() || typeof item.output !== "string") return undefined;
  const match = /^\s*<codex_delegation>\s*<source_thread_id>\s*([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\s*<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/i.exec(item.output);
  // The inner prompt is literal text, not XML/Markdown to interpret or execute.
  return match ? { id: item.id, type: "delegatedInput", text: match[2], sourceThreadId: match[1],
    delegatedInputIsReplay: item.type !== "function_call_output" } : undefined;
}
