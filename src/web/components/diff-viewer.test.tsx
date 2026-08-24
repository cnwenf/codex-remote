import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffViewer } from "./diff-viewer";

describe("DiffViewer", () => {
  it("renders diff text as text rather than HTML", () => {
    render(<DiffViewer diff={'<script>alert("x")</script>'} />);

    expect(screen.getByText(/<script>/)).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  });

  it("announces when a large diff is truncated", () => {
    render(<DiffViewer diff={`+${"a".repeat(200)}`} maxChars={80} />);

    expect(screen.getByText("Diff truncated for display")).toBeVisible();
  });
});
