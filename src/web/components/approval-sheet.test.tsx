import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RpcRequest } from "../../protocol/types";
import { ApprovalSheet } from "./approval-sheet";

const request: RpcRequest = {
  id: "server-1",
  method: "item/commandExecution/requestApproval",
  params: { command: "pnpm test", cwd: "/code/app" },
};

describe("ApprovalSheet", () => {
  it("does not approve without an explicit accept click", () => {
    const onResolve = vi.fn();
    render(<ApprovalSheet request={request} onResolve={onResolve} />);

    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("returns focus to the previous control after the dialog closes", () => {
    const onResolve = vi.fn();
    const { rerender } = render(<button type="button">Composer action</button>);
    const trigger = screen.getByRole("button", { name: "Composer action" });
    trigger.focus();
    expect(trigger).toHaveFocus();

    rerender(<>
      <button type="button">Composer action</button>
      <ApprovalSheet request={request} onResolve={onResolve} />
    </>);
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();

    rerender(<button type="button">Composer action</button>);

    expect(screen.getByRole("button", { name: "Composer action" })).toHaveFocus();
  });

  it("resolves a request exactly once", async () => {
    const onResolve = vi.fn();
    render(<ApprovalSheet request={request} onResolve={onResolve} />);

    const approve = screen.getByRole("button", { name: "Approve once" });
    await userEvent.click(approve);
    await userEvent.click(approve);

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({
      decision: "accept",
      result: { decision: "accept" },
    });
  });

  it("returns the exact requested permission grant or an empty denial", async () => {
    const onResolve = vi.fn();
    render(<ApprovalSheet request={{
      id: "permission-1",
      method: "item/permissions/requestApproval",
      params: {
        permissions: { network: { enabled: true } },
      },
    }} onResolve={onResolve} />);

    await userEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(onResolve).toHaveBeenCalledWith({
      decision: "accept",
      result: {
        permissions: { network: { enabled: true } },
        scope: "turn",
      },
    });
  });

  it("collects structured answers for request_user_input", async () => {
    const onResolve = vi.fn();
    render(<ApprovalSheet request={{
      id: "input-1",
      method: "item/tool/requestUserInput",
      params: {
        questions: [{
          id: "deploy_mode",
          header: "Mode",
          question: "How should this deploy?",
          options: [
            { label: "Canary", description: "Deploy to canary first" },
            { label: "All", description: "Deploy to all hosts" },
          ],
        }],
      },
    }} onResolve={onResolve} />);

    await userEvent.click(screen.getByRole("radio", { name: /Canary/ }));
    await userEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onResolve).toHaveBeenCalledWith({
      decision: "accept",
      result: { answers: { deploy_mode: { answers: ["Canary"] } } },
    });
  });
});
