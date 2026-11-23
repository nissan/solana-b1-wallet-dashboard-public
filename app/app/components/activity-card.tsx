"use client";

import { address } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useAppClient } from "../lib/client-provider";
import { useActivity } from "../lib/hooks/use-activity";
import {
  MAX_TOKEN_ACCOUNTS,
  type Activity,
  type TokenAccountCounts,
} from "../lib/activity";
import { formatAmount } from "../lib/amount";
import { ellipsify } from "../lib/explorer";
import { useCluster } from "./cluster-context";

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

function when(blockTime: number | null): string {
  if (blockTime == null) return "time unknown";
  const seconds = blockTime - Date.now() / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

/** One plain sentence per transaction, e.g. "Sent 0.01 SOL to 2za3...n6t3". */
export function describeActivity(a: Activity): string {
  const token = a.mint === null ? "SOL" : (a.symbol ?? ellipsify(a.mint));
  const amount = `${formatAmount(a.amount, a.decimals)} ${token}`;
  let text: string;
  if (a.direction === "sent") {
    text = `Sent ${amount}${a.counterparty ? ` to ${ellipsify(a.counterparty)}` : ""}`;
  } else if (a.direction === "received") {
    text = a.counterparty
      ? `Received ${amount} from ${ellipsify(a.counterparty)}`
      : a.mint === null
        ? `Received ${amount}`
        : `Received ${amount} (minted)`;
  } else {
    text = "Transaction with no balance change for this wallet";
  }
  return a.failed ? `Failed: ${text}` : text;
}

/**
 * Said when a load left out a token account holding a balance (B1-012), e.g.
 * "Only 10 of this wallet's 12 token accounts holding a balance were read, so
 * a deposit into one of the other 2 may be missing." Takes the counts of
 * accounts holding a balance: unread empty accounts give no warning.
 */
export function unreadTokenAccountsNote({
  read,
  total,
}: TokenAccountCounts): string | null {
  const unread = total - read;
  if (unread <= 0) return null;
  const others = unread === 1 ? "the other one" : `one of the other ${unread}`;
  return `Only ${read} of this wallet's ${total} token accounts holding a balance were read, so a deposit into ${others} may be missing.`;
}

export function ActivityCard() {
  const client = useAppClient();
  const connected = useConnectedWallet(client);
  const owner = connected ? address(connected.account.address) : undefined;
  const { activity, fundedTokenAccounts, error, isLoading, isRetrying, retry } =
    useActivity(owner);
  const unreadNote =
    fundedTokenAccounts && unreadTokenAccountsNote(fundedTokenAccounts);
  const { getExplorerUrl } = useCluster();

  return (
    <section
      className="rounded-2xl border border-border-low bg-card p-6 sm:col-span-2"
      aria-label="Recent activity"
    >
      <h2 className="text-sm font-semibold">Recent activity</h2>
      <p className="mt-1 text-xs text-muted">
        The last 20 transactions for this wallet and up to {MAX_TOKEN_ACCOUNTS}{" "}
        of its token accounts.
      </p>
      {unreadNote && <p className="mt-1 text-xs text-muted">{unreadNote}</p>}
      {isLoading && (
        <p className="mt-4 text-xs text-muted" role="status">
          Loading recent activity...
        </p>
      )}
      {error && (
        <div
          className="mt-4 flex items-center justify-between gap-3 text-xs"
          role="alert"
        >
          <p className="text-destructive">
            Could not load recent activity. The RPC may be busy or unreachable;
            your balances above are unaffected.
          </p>
          <button
            type="button"
            onClick={retry}
            disabled={isRetrying}
            className="shrink-0 cursor-pointer rounded-lg border border-border-low px-3 py-1.5 font-medium disabled:opacity-50"
          >
            {isRetrying ? "Retrying..." : "Retry"}
          </button>
        </div>
      )}
      {activity?.length === 0 && (
        <p className="mt-4 text-xs text-muted">No transactions yet.</p>
      )}
      {activity && activity.length > 0 && (
        <ul className="mt-4 divide-y divide-border-low text-sm">
          {activity.map((a) => (
            <li
              key={a.signature}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className={a.failed ? "text-destructive" : undefined}>
                {describeActivity(a)}
              </span>
              <span className="flex shrink-0 items-center gap-3 text-xs text-muted">
                <time
                  dateTime={
                    a.blockTime
                      ? new Date(a.blockTime * 1000).toISOString()
                      : undefined
                  }
                >
                  {when(a.blockTime)}
                </time>
                <a
                  href={getExplorerUrl(`/tx/${a.signature}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  View
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
