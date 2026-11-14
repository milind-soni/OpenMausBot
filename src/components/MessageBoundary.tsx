import { Component, type ReactNode } from "react";

import { useAdvancedMode } from "@/lib/interface-mode";
import { plainBotBubble } from "./chat-bubble";

function FallbackBubble({ text }: { text: string }) {
  const simple = !useAdvancedMode();
  return <div data-chat-bubble={simple ? "simple" : ""} className={plainBotBubble(simple)}>{text}</div>;
}

export class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <FallbackBubble text={this.props.fallbackText} />;
    }
    return this.props.children;
  }
}
