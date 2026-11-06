import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Mail } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import type { EmailAccountView, EmailStatus } from "../../shared/email";
import { ASK_FIELD, AskCard } from "./AskCard";
import { EmailMailbox } from "./EmailMailbox";

/** A chat's mailbox card once connected: the same mailbox as in Apps, with a test to itself, and its outgoing server open
 * while sending doesn't work. Where the mailbox can't be shown (gone, or this person doesn't manage mailboxes), the
 * settled line instead. */
export function EmailRequestSettled({ address, label, settled, initial }: { address: string; label: string; settled: ReactNode; initial?: EmailAccountView }) {
  const [account, setAccount] = useState<EmailAccountView | null>(initial ?? null);
  const load = useCallback(async () => {
    try {
      const status = await api("/api/email") as EmailStatus;
      setAccount(status.accounts.find((one) => one.address.toLowerCase() === address.toLowerCase()) ?? null);
    } catch { setAccount(null); }
  }, [address]);
  useEffect(() => { if (!initial) void load(); }, [initial, load]);
  if (!account) return <>{settled}</>;
  return (
    <AskCard ariaLabel={label} icon={<Mail size={15} />} title={<span dir="ltr">{account.address}</span>}>
      <EmailMailbox account={account} onChanged={(next) => (next ? setAccount(next) : load())} fieldClassName={cn(ASK_FIELD, "w-full")} />
    </AskCard>
  );
}
