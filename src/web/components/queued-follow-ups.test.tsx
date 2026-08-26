import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueuedFollowUps } from "./queued-follow-ups";

describe("QueuedFollowUps", () => {
  it("shows Desktop queued messages and lets the user promote one to steer", async () => {
    const onSteer = vi.fn();
    render(<QueuedFollowUps
      messages={[{ id: "queued-1", text: "Run this after the current turn" }]}
      onSteer={onSteer}
    />);

    expect(screen.getByText("排队消息")).toBeVisible();
    expect(screen.getByText("Run this after the current turn")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "转为引导" }));
    expect(onSteer).toHaveBeenCalledWith("queued-1");
  });

  it("keeps a promoted message visible with a non-repeatable transition state", () => {
    render(<QueuedFollowUps
      messages={[{ id: "queued-1", text: "Guide this now", lifecycle: "promoting" }]}
      onSteer={vi.fn()}
    />);

    expect(screen.getByText("Guide this now")).toBeVisible();
    expect(screen.getByRole("button", { name: "正在转为引导…" })).toBeDisabled();
  });

  it("shows a failed promotion as retryable", async () => {
    const onSteer = vi.fn();
    render(<QueuedFollowUps
      messages={[{ id: "queued-1", text: "Retry this", lifecycle: "failed" }]}
      onSteer={onSteer}
    />);

    await userEvent.click(screen.getByRole("button", { name: "重试引导" }));
    expect(onSteer).toHaveBeenCalledWith("queued-1");
  });
});
