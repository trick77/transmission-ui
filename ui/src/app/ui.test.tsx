import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Elapsed, NumInput, TextInput } from "./ui";

describe("Elapsed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("counts up on its own, without the parent re-rendering", () => {
    const since = Date.parse("2026-10-01T11:48:00Z") / 1000;
    const { container } = render(<Elapsed since={since} />);
    expect(container.textContent).toBe("12m 0s");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toBe("12m 3s");
  });
});

describe("NumInput", () => {
  it("shows a new value from outside, replacing the draft", () => {
    const { rerender } = render(<NumInput value={5} onCommit={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "7" } });
    expect(input).toHaveValue("7");

    rerender(<NumInput value={9} onCommit={() => {}} />);
    expect(input).toHaveValue("9");
  });

  it("keeps the draft while the value from outside stays the same", () => {
    const { rerender } = render(<NumInput value={5} onCommit={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "7" } });

    rerender(<NumInput value={5} onCommit={() => {}} />);
    expect(input).toHaveValue("7");
  });
});

describe("TextInput", () => {
  it("shows a new value from outside, replacing the draft", () => {
    const { rerender } = render(<TextInput value="a" onCommit={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "draft" } });

    rerender(<TextInput value="b" onCommit={() => {}} />);
    expect(input).toHaveValue("b");
  });
});
