import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { MessageDeliveries } from "./message-deliveries";
import type { MessageDelivery } from "../../protocol/message-delivery";

it("allows retry only after a confirmed failure, keeping uncertain delivery visible", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const receipt: MessageDelivery = { id: "m1", threadId: "t1", operation: "start", text: "Continue",
    status: "uncertain", createdAt: 1, updatedAt: 1, revision: 1 };
  const { rerender } = render(<MessageDeliveries messages={[receipt]} onRetry={retry} />);
  expect(screen.getByText(/发送结果待确认/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "重试发送" })).toBeNull();
  rerender(<MessageDeliveries messages={[{ ...receipt, status: "failed" }]} onRetry={retry} />);
  await userEvent.click(screen.getByRole("button", { name: "重试发送" }));
  expect(retry).toHaveBeenCalledWith("m1");
});
