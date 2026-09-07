import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hydrateThread } from "../state/conversation-history";
import { initialCodexState } from "../../protocol/thread-store";
import { Timeline } from "./timeline";

const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[internal provenance]\n</citation_entries>\n<rollout_ids>\ninternal-id\n</rollout_ids>\n</oai-mem-citation>";

function show(text: string, type = "agentMessage") {
  const state = hydrateThread(initialCodexState, { thread: { id: "t", status: "idle", turns: [
    { id: "qa", status: "completed", items: [{ id: "message", type, text }] },
  ] } });
  return render(<Timeline thread={state.threads.t} />);
}

describe("assistant message presentation", () => {
  it("keeps the answer while hiding the internal memory footer", () => {
    const { container } = show(`正文保持完整。\n\n${citation}`);
    expect(screen.getByText("正文保持完整。")).toBeVisible();
    expect(container.textContent).not.toContain("internal provenance");
    expect(container.textContent).not.toContain("oai-mem-citation");
  });

  it("shows the heartbeat result without its notification control envelope", () => {
    const { container } = show("<heartbeat>\n<automation_id>hidden-id</automation_id>\n<decision>DONT_NOTIFY</decision>\n<message>今日检查完成，无需处理。</message>\n</heartbeat>");
    expect(screen.getByText("今日检查完成，无需处理。")).toBeVisible();
    expect(container.textContent).not.toContain("DONT_NOTIFY");
    expect(container.textContent).not.toContain("hidden-id");
  });

  it("preserves literal control syntax in code examples and user messages", () => {
    const { unmount } = show(`示例：\n\n\`\`\`xml\n${citation}\n\`\`\``);
    expect(screen.getByText(/internal provenance/)).toBeVisible();
    unmount();
    show(citation, "userMessage");
    expect(screen.getByText(/internal provenance/)).toBeVisible();
  });

  it("does not discard malformed or ordinary HTML-like assistant content", () => {
    show("<heartbeat>\nThis is an example, not a complete envelope.");
    expect(screen.getByText(/This is an example/)).toBeVisible();
  });
});
