import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQuestionSubmissionGate, OptionCardView } from "./OptionCard";

const question = {
  id: "question",
  role: "bot" as const,
  kind: "options" as const,
  at: 1,
  card: {
    title: "Question",
    subtitle: "Choose",
    options: ["A", "B"],
    requestId: "request",
  },
};

interface InteractiveProps {
  children?: ReactNode;
  onClick?: () => void;
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
  "aria-label"?: string;
}

function elements(node: ReactNode): Array<ReactElement<InteractiveProps>> {
  if (!isValidElement<InteractiveProps>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}

describe("OptionCard interactions", () => {
  it("claims an option submission once even when the button fires twice", () => {
    const onAnswer = vi.fn();
    const gate = createQuestionSubmissionGate();
    const tree = OptionCardView({
      message: question,
      custom: "",
      selected: [],
      setCustom: vi.fn(),
      toggle: vi.fn(),
      claimSubmission: gate.claim,
      onAnswer,
      onDismiss: vi.fn(),
    });
    const buttons = elements(tree).filter((element) => element.type === "button");

    buttons[1]!.props.onClick!();
    buttons[1]!.props.onClick!();

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      answer: "A",
      selected: ["A"],
    });
  });

  it("claims dismissal once even when the close button fires twice", () => {
    const onDismiss = vi.fn();
    const gate = createQuestionSubmissionGate();
    const tree = OptionCardView({
      message: question,
      custom: "",
      selected: [],
      setCustom: vi.fn(),
      toggle: vi.fn(),
      claimSubmission: gate.claim,
      onAnswer: vi.fn(),
      onDismiss,
    });
    const close = elements(tree).find((element) => element.type === "button" && element.props["aria-label"] === "Dismiss question");

    close!.props.onClick!();
    close!.props.onClick!();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("submits an empty custom answer as an explicit skip on Enter", () => {
    const onAnswer = vi.fn();
    const gate = createQuestionSubmissionGate();
    const tree = OptionCardView({
      message: question,
      custom: "",
      selected: [],
      setCustom: vi.fn(),
      toggle: vi.fn(),
      claimSubmission: gate.claim,
      onAnswer,
      onDismiss: vi.fn(),
    });
    const input = elements(tree).find((element) => element.type === "input");
    const preventDefault = vi.fn();

    input!.props.onKeyDown!({ key: "Enter", preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onAnswer).toHaveBeenCalledWith({
      answer: "Skipped",
      selected: [],
    });
  });
});
