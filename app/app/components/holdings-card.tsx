"use client";

import { address } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useAppClient } from "../lib/client-provider";
import { useBalance } from "../lib/hooks/use-balance";
import { useHoldings } from "../lib/hooks/use-holdings";
import { formatAmount } from "../lib/amount";
import { ellipsify } from "../lib/explorer";
import { useCluster } from "./cluster-context";

export function HoldingsCard() {
  const client = useAppClient();
  const connected = useConnectedWallet(client);
  const owner = connected ? address(connected.account.address) : undefined;
  const sol = useBalance(owner);
  const tokens = useHoldings(owner);
  const { getExplorerUrl } = useCluster();

  return (
    <div className="rounded-2xl border border-border-low bg-card p-6 sm:col-span-2">
      <h2 className="text-sm font-semibold">Holdings</h2>
      <table className="mt-4 w-full text-sm" aria-label="Holdings">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-2 font-medium">Asset</th>
            <th className="pb-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border-low">
            <td className="py-2 font-medium">SOL</td>
            <td className="py-2 text-right font-mono" data-testid="balance-SOL">
              {sol.lamports != null
                ? `${formatAmount(sol.lamports, 9)} SOL`
                : sol.error
                  ? "Unavailable"
                  : "Loading..."}
            </td>
          </tr>
          {tokens.holdings?.map((h) => {
            const label = h.symbol ?? ellipsify(h.mint);
            return (
              <tr key={h.mint} className="border-t border-border-low">
                <td className="py-2">
                  <a
                    href={getExplorerUrl(`/address/${h.mint}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={h.mint}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {label}
                  </a>
                </td>
                <td
                  className="py-2 text-right font-mono"
                  data-testid={`balance-${h.mint}`}
                >
                  {formatAmount(h.amount, h.decimals)} {label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tokens.isLoading && (
        <p className="mt-3 text-xs text-muted" role="status">
          Loading token balances...
        </p>
      )}
      {tokens.error && (
        <p className="mt-3 text-xs text-destructive" role="alert">
          Could not load token balances: {tokens.error.message}
        </p>
      )}
      {tokens.holdings?.length === 0 && (
        <p className="mt-3 text-xs text-muted">No SPL token balances.</p>
      )}
    </div>
  );
}
