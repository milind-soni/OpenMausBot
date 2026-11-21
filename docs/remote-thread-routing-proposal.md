# Cross-machine conversations and delegation

A user with several paired installations should be able to start a conversation from their bot's chat, choose an execution host, and open that same conversation from the bot's sidebar. Today a thread created on another installation has its own conversation list.

## Proposed behavior

- Allow users and authorized bots to pick a paired host when opening a new conversation. Use the existing local behavior when no host is selected.
- Display the host and run status alongside the conversation. Keep a stable reference to the host and its thread ID so reopening the conversation, sending follow-ups, and receiving events all address the same thread.
- Let the originating bot steer its delegated threads and receive results, questions, and blockers in the originating conversation. Let the user open a delegated thread and interact with it directly, including responding to permission requests.
- Show an unavailable host state and reconnect to the same thread when the host returns. Deduplicate launch and follow-up requests on retry.
- Enforce authorization on the execution host, including thread visibility, workspace access, and approvals. Keep the sidebar's owning bot separate from the runtime identity authorized by the destination. Establish how that mapping is configured before implementation.

## Acceptance scenario

From one bot conversation, launch jobs on two paired machines. Both appear under the originating bot. Open each row and verify that a benign hostname check runs on the indicated machine. Send another message from the sidebar and one from the originating bot. Verify that both reach the same destination thread and that results and blockers reach the originating chat. Reconnect a host and verify conversation continuity without launching a duplicate. Verify that revoking a host pairing blocks subsequent actions.

T3 Code provides a reference for environment-scoped thread addresses and delegated results that survive reconnects. See its [remote access documentation](https://github.com/pingdotgg/t3code/blob/ffb42a0/docs/user/remote-access.md).
