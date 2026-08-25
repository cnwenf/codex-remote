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
});
