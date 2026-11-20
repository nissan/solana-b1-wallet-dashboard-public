import {
  address,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { attachSymbols } from "./holdings";

const LIMIT = 20;
const FETCH_TIMEOUT_MS = 15_000;

export type Activity = {
  signature: Signature;
  /** Unix seconds; null when the node has no block time. */
  blockTime: number | null;
  failed: boolean;
  direction: "sent" | "received" | "none";
  /** null for SOL. */
  mint: Address | null;
  programId: Address | null;
  symbol: string | null;
  decimals: number;
  /** Absolute amount in base units. */
  amount: bigint;
  /** The other wallet whose balance moved the opposite way, if any. */
  counterparty: Address | null;
};

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

type ParsedTransaction = {
  blockTime: bigint | number | null;
  meta: {
    err: unknown;
    fee: bigint | number;
    preBalances: (bigint | number)[];
    postBalances: (bigint | number)[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    message: { accountKeys: { pubkey: string; signer: boolean }[] };
  };
};

/**
 * Reads the owner's last 20 transactions and describes, for each, the one
 * balance change that matters to the owner: a token movement if there is one,
 * otherwise the SOL movement net of the fee the owner paid.
 */
export async function fetchActivity(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address
): Promise<Activity[]> {
  const abortSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signatures = await rpc
    .getSignaturesForAddress(owner, { limit: LIMIT, commitment: "confirmed" })
    .send({ abortSignal });
  const transactions = await Promise.all(
    signatures.map(({ signature }) =>
      rpc
        .getTransaction(signature, {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 1,
          commitment: "confirmed",
        })
        .send({ abortSignal })
    )
  );

  const activity = signatures.map(({ signature, blockTime }, i) =>
    describe(
      signature,
      transactions[i] as unknown as ParsedTransaction | null,
      owner,
      blockTime == null ? null : Number(blockTime)
    )
  );
  const tokens = activity.filter(
    (a) => a.mint !== null && a.programId !== null
  );
  await attachSymbols(
    rpc,
    tokens as (Activity & { mint: Address; programId: Address })[],
    abortSignal
  );
  return activity;
}

export function describe(
  signature: Signature,
  tx: ParsedTransaction | null,
  owner: Address,
  blockTime: number | null
): Activity {
  const base: Activity = {
    signature,
    // Kit returns UnixTimestamp as a bigint; the UI does number arithmetic.
    blockTime: tx?.blockTime != null ? Number(tx.blockTime) : blockTime,
    failed: tx?.meta?.err != null,
    direction: "none",
    mint: null,
    programId: null,
    symbol: null,
    decimals: 9,
    amount: 0n,
    counterparty: null,
  };
  const meta = tx?.meta;
  if (!tx || !meta) return base;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);

  // Token movement first: the owner's net change per mint across its token accounts.
  const tokenDelta = new Map<string, { delta: bigint; entry: TokenBalance }>();
  const add = (entry: TokenBalance, sign: 1n | -1n) => {
    const key = `${entry.owner}|${entry.mint}`;
    const current = tokenDelta.get(key) ?? { delta: 0n, entry };
    current.delta += sign * BigInt(entry.uiTokenAmount.amount);
    tokenDelta.set(key, current);
  };
  meta.preTokenBalances?.forEach((e) => add(e, -1n));
  meta.postTokenBalances?.forEach((e) => add(e, 1n));
  for (const { delta, entry } of tokenDelta.values()) {
    if (entry.owner !== owner || delta === 0n) continue;
    const other = [...tokenDelta.values()].find(
      (o) =>
        o.entry.mint === entry.mint &&
        o.entry.owner !== owner &&
        o.delta === -delta
    );
    return {
      ...base,
      direction: delta < 0n ? "sent" : "received",
      mint: address(entry.mint),
      programId: entry.programId ? address(entry.programId) : null,
      decimals: entry.uiTokenAmount.decimals,
      amount: delta < 0n ? -delta : delta,
      counterparty: other?.entry.owner ? address(other.entry.owner) : null,
    };
  }

  // Otherwise SOL: add back the fee if the owner paid it.
  const ownerIndex = keys.indexOf(owner);
  if (ownerIndex < 0) return base;
  // Account 0 is the fee payer; net its fee out so transfers match exactly.
  const lamports = (i: number) =>
    BigInt(meta.postBalances[i]) -
    BigInt(meta.preBalances[i]) +
    (i === 0 ? BigInt(meta.fee) : 0n);
  const delta = lamports(ownerIndex);
  if (delta === 0n) return base;
  const otherIndex = keys.findIndex(
    (_, i) => i !== ownerIndex && lamports(i) === -delta
  );
  return {
    ...base,
    direction: delta < 0n ? "sent" : "received",
    amount: delta < 0n ? -delta : delta,
    counterparty: otherIndex >= 0 ? address(keys[otherIndex]) : null,
  };
}
