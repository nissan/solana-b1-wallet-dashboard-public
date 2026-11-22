import {
  address,
  getBase64Encoder,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { attachSymbols, TOKEN_2022_PROGRAM_ADDRESS } from "./holdings";

const LIMIT = 20;
// Raised from 15 s for B1-008: on the forked-mainnet test network a
// getTokenAccountsByOwner call sometimes stalls for about 10 s right after a
// send, and at 15 s the B1-004 send test failed 3 of 4 local runs (2 of 2 passed
// at 25 s). It stays below that test's 30 s wait. See docs/evidence/B1-008.md.
const FETCH_TIMEOUT_MS = 25_000;
// Signature lookups in flight at once. A wallet with many token accounts would
// otherwise burst one request per account at the RPC and its rate limit.
const SIGNATURE_CONCURRENCY = 5;
// Token accounts whose signatures are read per load. Bounds the cost of a load
// at 2 listing calls + 1 owner call + this many lookups, whatever the wallet
// holds. Transfers into accounts beyond the cap are not listed.
export const MAX_TOKEN_ACCOUNTS = 10;
// SPL Token and Token-2022 accounts share the base layout: mint (32 bytes),
// owner (32), then the amount as a little-endian u64 at byte 64.
const AMOUNT_SLICE = { offset: 64, length: 8 } as const;

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

export type SignatureEntry = {
  signature: Signature;
  slot: bigint | number;
  blockTime: bigint | number | null;
};

/** Sort comparator: larger values first, a missing value last. */
function newestFirst(a: bigint | number | null, b: bigint | number | null) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  const [x, y] = [BigInt(a), BigInt(b)];
  return x === y ? 0 : x > y ? -1 : 1;
}

/**
 * Merges signature lists read for several addresses: each signature once,
 * newest first by slot and then block time, at most `limit` entries.
 */
export function mergeSignatures<T extends SignatureEntry>(
  lists: readonly (readonly T[])[],
  limit = LIMIT
): T[] {
  const bySignature = new Map<Signature, T>();
  for (const list of lists) {
    for (const entry of list) {
      if (!bySignature.has(entry.signature)) {
        bySignature.set(entry.signature, entry);
      }
    }
  }
  return [...bySignature.values()]
    .sort(
      (a, b) =>
        newestFirst(a.slot, b.slot) || newestFirst(a.blockTime, b.blockTime)
    )
    .slice(0, limit);
}

export type TokenAccountRef = { address: Address; amount: bigint };

/**
 * Chooses which token accounts to read, at most `cap`: accounts holding a
 * balance first, then empty ones, each group in address order, so the same
 * holdings always give the same choice.
 */
export function pickTokenAccounts(
  accounts: readonly TokenAccountRef[],
  cap = MAX_TOKEN_ACCOUNTS
): Address[] {
  return [...accounts]
    .sort(
      (a, b) =>
        Number(b.amount > 0n) - Number(a.amount > 0n) ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
    )
    .slice(0, cap)
    .map((a) => a.address);
}

function readAmount(base64: string): bigint {
  const bytes = new Uint8Array(getBase64Encoder().encode(base64));
  if (bytes.length < 8) return 0n;
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
}

/** Runs `fn` over `items` with at most `limit` calls in flight; stops starting new calls after the first failure. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/**
 * Reads the owner's last 20 transactions and describes, for each, the one
 * balance change that matters to the owner: a token movement if there is one,
 * otherwise the SOL movement net of the fee the owner paid.
 *
 * A token transfer into an existing token account names that account but not
 * the owner, so up to MAX_TOKEN_ACCOUNTS of the owner's SPL Token and
 * Token-2022 accounts are read too and their signatures merged with the
 * owner's. The owner's own lookup runs alongside the account listing.
 */
export async function fetchActivity(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address
): Promise<Activity[]> {
  const abortSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signaturesFor = (a: Address) =>
    rpc
      .getSignaturesForAddress(a, { limit: LIMIT, commitment: "confirmed" })
      .send({ abortSignal });
  const listAccounts = Promise.all(
    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          owner,
          { programId },
          {
            encoding: "base64",
            dataSlice: AMOUNT_SLICE,
            commitment: "confirmed",
          }
        )
        .send({ abortSignal })
    )
  );
  const [ownerSignatures, tokenAccounts] = await Promise.all([
    signaturesFor(owner),
    listAccounts,
  ]);
  const picked = pickTokenAccounts(
    tokenAccounts.flatMap(({ value }) =>
      value.map(({ pubkey, account }) => ({
        address: pubkey,
        amount: readAmount(account.data[0]),
      }))
    )
  );
  const tokenSignatures = await mapLimit(
    picked,
    SIGNATURE_CONCURRENCY,
    signaturesFor
  );
  const signatures = mergeSignatures([ownerSignatures, ...tokenSignatures]);
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
