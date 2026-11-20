"use client";

import { useState, type FormEvent } from "react";
import { address, isAddress, lamports, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useAppClient } from "../../lib/client-provider";
import { useBalance } from "../../lib/hooks/use-balance";
import { useHoldings } from "../../lib/hooks/use-holdings";
import { activityKey } from "../../lib/hooks/use-activity";
import { useSWRConfig } from "swr";
import { formatAmount, parseAmount } from "../../lib/amount";
import { ellipsify } from "../../lib/explorer";
import { parseTransactionError } from "../../lib/errors";
import { useCluster } from "../cluster-context";

const SOL = "SOL";
const SOL_DECIMALS = 9;
// One signature (5,000 lamports) plus the client's fixed 5,000-lamport
// priority fee (solana-client.ts). Kept back so a max send still pays fees.
const SOL_FEE_RESERVE = 10_000n;

type Status =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "confirmed"; signature: string; summary: string }
  | { kind: "failed"; message: string };

type FieldErrors = { recipient?: string; amount?: string };

export function SendCard() {
  const client = useAppClient();
  const connected = useConnectedWallet(client);
  const owner = connected ? address(connected.account.address) : undefined;
  const sol = useBalance(owner);
  const { holdings, refresh } = useHoldings(owner);
  const { cluster, getExplorerUrl } = useCluster();
  const { mutate } = useSWRConfig();

  const [asset, setAsset] = useState<string>(SOL);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const sendable = (holdings ?? []).filter(
    (h) => h.programId === TOKEN_PROGRAM_ADDRESS
  );
  const unsendableCount = (holdings?.length ?? 0) - sendable.length;
  const token = sendable.find((h) => h.mint === asset);
  const label = token ? (token.symbol ?? ellipsify(token.mint)) : SOL;

  const validate = (): { to: Address; units: bigint } | FieldErrors => {
    const found: FieldErrors = {};
    const trimmed = recipient.trim();
    if (!isAddress(trimmed)) {
      found.recipient = "Enter a valid Solana address";
    }

    const decimals = token ? token.decimals : SOL_DECIMALS;
    let units: bigint | null = null;
    try {
      units = parseAmount(amount, decimals);
    } catch (error) {
      found.amount = (error as Error).message;
    }

    if (units !== null) {
      if (token) {
        if (units > token.amount) {
          found.amount = `Amount exceeds your balance of ${formatAmount(token.amount, decimals)} ${label}`;
        }
      } else if (sol.lamports == null) {
        found.amount = "Your SOL balance has not loaded yet";
      } else {
        const available =
          sol.lamports > SOL_FEE_RESERVE ? sol.lamports - SOL_FEE_RESERVE : 0n;
        if (units > available) {
          found.amount = `Amount exceeds your balance of ${formatAmount(available, decimals)} SOL after network fees`;
        }
      }
    }

    if (found.recipient || found.amount || units === null) return found;
    return { to: address(trimmed), units };
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const signer = connected?.signer;
    if (!signer || status.kind === "signing") return;

    const result = validate();
    if (!("to" in result)) {
      setErrors(result);
      return;
    }
    setErrors({});
    setStatus({ kind: "signing" });

    const summary = `${formatAmount(result.units, token ? token.decimals : SOL_DECIMALS)} ${label} to ${ellipsify(result.to)}`;
    try {
      const sent = token
        ? await client.token.instructions
            .transferToATA({
              mint: token.mint,
              authority: signer,
              recipient: result.to,
              amount: result.units,
              decimals: token.decimals,
            })
            .sendTransaction()
        : await client.system.instructions
            .transferSol({
              source: signer,
              destination: result.to,
              amount: lamports(result.units),
            })
            .sendTransaction();
      setStatus({
        kind: "confirmed",
        signature: sent.context.signature,
        summary,
      });
      setAmount("");
      // A failed refresh must not turn a confirmed send into "Send failed".
      await Promise.allSettled([
        refresh(),
        owner && mutate(activityKey(cluster, owner)),
      ]);
    } catch (error) {
      console.error(error);
      setStatus({ kind: "failed", message: parseTransactionError(error) });
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-2xl border border-border-low bg-card p-6"
      aria-label="Send"
    >
      <h2 className="text-sm font-semibold">Send</h2>
      <p className="mt-1 text-xs text-muted">
        Send SOL or an SPL token from your connected wallet.
      </p>
      <div className="mt-4 space-y-3">
        <Select
          value={asset}
          onValueChange={(value) => {
            setAsset(value ?? SOL);
            setErrors({});
          }}
        >
          <SelectLabel className="block text-xs font-medium">Asset</SelectLabel>
          <SelectTrigger className="flex w-full items-center justify-between rounded-lg border border-border-low bg-background px-3 py-2 text-sm outline-none focus:border-ring">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-50 min-w-48 rounded-lg border border-border-low bg-card p-1 text-sm shadow-lg">
            <SelectItem
              value={SOL}
              className="cursor-pointer rounded px-2 py-1.5 data-[highlighted]:bg-background"
            >
              SOL
            </SelectItem>
            {sendable.map((h) => (
              <SelectItem
                key={h.mint}
                value={h.mint}
                className="cursor-pointer rounded px-2 py-1.5 data-[highlighted]:bg-background"
              >
                {h.symbol ?? ellipsify(h.mint)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {unsendableCount > 0 && (
          <p className="text-xs text-muted">
            Token-2022 balances are shown in Holdings but cannot be sent from
            here yet.
          </p>
        )}

        <label htmlFor="send-recipient" className="block text-xs font-medium">
          Recipient address
        </label>
        <input
          id="send-recipient"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={errors.recipient != null}
          aria-describedby={
            errors.recipient ? "send-recipient-error" : undefined
          }
          className="w-full rounded-lg border border-border-low bg-background px-3 py-2 font-mono text-xs outline-none focus:border-ring"
        />
        {errors.recipient && (
          <p id="send-recipient-error" className="text-xs text-destructive">
            {errors.recipient}
          </p>
        )}

        <label htmlFor="send-amount" className="block text-xs font-medium">
          Amount ({label})
        </label>
        <input
          id="send-amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-invalid={errors.amount != null}
          aria-describedby={errors.amount ? "send-amount-error" : undefined}
          className="w-full rounded-lg border border-border-low bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        {errors.amount && (
          <p id="send-amount-error" className="text-xs text-destructive">
            {errors.amount}
          </p>
        )}

        <button
          type="submit"
          disabled={!connected?.signer || status.kind === "signing"}
          className="w-full cursor-pointer rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {status.kind === "signing" ? "Confirm in your wallet..." : "Send"}
        </button>

        <div role="status" aria-live="polite" className="text-xs">
          {status.kind === "signing" && (
            <p className="text-muted">
              Waiting for signature and confirmation...
            </p>
          )}
          {status.kind === "confirmed" && (
            <p>
              Confirmed: {status.summary}.{" "}
              <a
                href={getExplorerUrl(`/tx/${status.signature}`)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View transaction {ellipsify(status.signature)}
              </a>
            </p>
          )}
          {status.kind === "failed" && (
            <p className="text-destructive">Send failed: {status.message}</p>
          )}
        </div>
      </div>
    </form>
  );
}
