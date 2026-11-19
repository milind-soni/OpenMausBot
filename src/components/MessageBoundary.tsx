import { Component, type ReactNode } from "react";

import { plainBotBubble } from "./chat-bubble";

function FallbackBubble({ text }: { text: string }) {

  return <div data-chat-bubble={""} className={plainBotBubble}>{text}</div>;
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
