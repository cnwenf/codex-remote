import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialCodexState } from "../../protocol/thread-store";
import { hydrateThread } from "../state/conversation-history";
import { Timeline } from "./timeline";

describe("delegated input presentation", () => {
  it("shows the original prompt and task source before the reply, never as a human or executable Markdown", () => {
    const sourceThreadId = "00000000-0000-4000-8000-000000000001";
    const text = "No tools.\n![test](/tmp/test.png)\n<script>doNotRun()</script>";
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "input", type: "delegatedInput", text, sourceThreadId },
      { id: "final", type: "agentMessage", text: "Final reply" },
    ] }] } });
    const { container } = render(<Timeline thread={state.threads.t} />);
    expect(screen.getByText(`来自任务 ${sourceThreadId.slice(0, 8)}`)).toBeVisible();
    expect(screen.getByTitle(sourceThreadId)).toBeVisible();
    const input = screen.getByText(/No tools\./);
    expect(input.textContent).toBe(text);
    expect(container.querySelector("[data-delegated-input]")).not.toHaveAttribute("data-user-message");
    expect(screen.queryByText("你")).not.toBeInTheDocument();
    expect(container.querySelector("img,script")).toBeNull();
    expect(container.textContent).not.toContain("codex_delegation");
    expect(input.compareDocumentPosition(screen.getByText("Final reply")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
