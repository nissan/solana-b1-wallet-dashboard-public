import {
  address,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { expect, test } from "vitest";
import {
  describe,
  fetchActivity,
  fundedCounts,
  holdsBalance,
  MAX_TOKEN_ACCOUNTS,
  mergeSignatures,
  pickTokenAccounts,
} from "../app/lib/activity";

const sig = (n: number) => `sig${n}` as Signature;
const entry = (n: number, slot: number, blockTime: number | null = slot) => ({
  signature: sig(n),
  slot: BigInt(slot),
  blockTime: blockTime == null ? null : BigInt(blockTime),
});

test("B1-008 S2: a signature found through the wallet and a token account appears once", () => {
  const wallet = [entry(3, 300), entry(1, 100)];
  const tokenAccount = [entry(2, 200), entry(1, 100)];
  const merged = mergeSignatures([wallet, tokenAccount]);
  expect(merged.map((e) => e.signature)).toEqual([sig(3), sig(2), sig(1)]);
});

test("B1-008 S2: rows are newest first by slot, then block time, with no block time last", () => {
  const merged = mergeSignatures([
    [entry(1, 100, 1_000), entry(2, 500, null)],
    [entry(3, 500, 2_000), entry(4, 300, 1_500)],
  ]);
  expect(merged.map((e) => e.signature)).toEqual([
    sig(3),
    sig(2),
    sig(4),
    sig(1),
  ]);
});

test("B1-008 S2: the merged list is capped at 20, keeping the newest", () => {
  const wallet = Array.from({ length: 20 }, (_, i) => entry(i, i * 2));
  const tokenAccount = Array.from({ length: 20 }, (_, i) =>
    entry(100 + i, i * 2 + 1)
  );
  const merged = mergeSignatures([wallet, tokenAccount]);
  expect(merged).toHaveLength(20);
  expect(merged[0].signature).toBe(sig(119));
  expect(merged.at(-1)!.slot).toBe(20n);
  for (let i = 1; i < merged.length; i++) {
    expect(merged[i - 1].slot > merged[i].slot).toBe(true);
  }
});

test("B1-008 S1: describe() reads a received token row when only the token accounts are in the transaction", () => {
  const owner = address("ET1aQ56Cz8fYsjCFgddfqeheAQpRLzX4skM8AsaYAQjx");
  const sender = address("Vote111111111111111111111111111111111111111");
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const programId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const balance = (accountIndex: number, owner: string, amount: string) => ({
    accountIndex,
    mint,
    owner,
    programId,
    uiTokenAmount: { amount, decimals: 6 },
  });
  const activity = describe(
    sig(1),
    {
      blockTime: 1_000n,
      meta: {
        err: null,
        fee: 5_000n,
        preBalances: [2_000_000_000n, 0n, 0n, 0n],
        postBalances: [1_999_995_000n, 0n, 0n, 0n],
        preTokenBalances: [
          balance(1, sender, "5000000"),
          balance(2, owner, "12345678"),
        ],
        postTokenBalances: [
          balance(1, sender, "3750000"),
          balance(2, owner, "13595678"),
        ],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: sender, signer: true },
            { pubkey: "SenderTokenAccount", signer: false },
            { pubkey: "WalletTokenAccount", signer: false },
            { pubkey: programId, signer: false },
          ],
        },
      },
    },
    owner,
    null
  );
  expect(activity).toMatchObject({
    direction: "received",
    mint,
    amount: 1_250_000n,
    decimals: 6,
    counterparty: sender,
    blockTime: 1_000,
  });
});

// Valid, distinct base58 addresses: "1" repeated, then a varying tail.
const tokenAccount = (n: number) =>
  address(`${"1".repeat(31)}${"23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}`);

test("B1-008: at most 10 token accounts are read, those holding a balance first", () => {
  expect(MAX_TOKEN_ACCOUNTS).toBe(10);
  // 6 empty accounts and 8 with a balance (odd n), in scrambled order.
  const accounts = [3, 12, 7, 0, 15, 9, 1, 14, 5, 11, 2, 8, 13, 4].map((n) => ({
    address: tokenAccount(n),
    amount: n % 2 ? BigInt(n) : 0n,
  }));
  const picked = pickTokenAccounts(accounts);
  expect(picked).toHaveLength(10);
  // All eight non-empty accounts, in address order, then the first two empty ones.
  expect(picked).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 0, 2].map(tokenAccount));
});

test("B1-008: the choice of token accounts does not depend on input order", () => {
  const accounts = Array.from({ length: 14 }, (_, n) => ({
    address: tokenAccount(n),
    amount: BigInt(n % 3),
  }));
  const reversed = [...accounts].reverse();
  expect(pickTokenAccounts(reversed)).toEqual(pickTokenAccounts(accounts));
  expect(pickTokenAccounts(accounts, 3)).toEqual([1, 2, 4].map(tokenAccount));
  expect(pickTokenAccounts([])).toEqual([]);
});

/**
 * An RPC stand-in that records each method called. The wallet and its token
 * accounts have no signatures, so a load reads nothing past the lookups.
 * SPL Token and Token-2022 accounts hold a balance of 5; `emptyAccounts` more
 * SPL Token accounts hold nothing (B1-012).
 */
function stubRpc(
  splAccounts: number,
  token2022Accounts: number,
  emptyAccounts = 0
) {
  const calls: string[] = [];
  const encode = (n: bigint) =>
    Buffer.from(new BigUint64Array([n]).buffer).toString("base64");
  const accounts = (count: number, offset: number, amount = encode(5n)) =>
    Array.from({ length: count }, (_, i) => ({
      pubkey: tokenAccount(offset + i),
      account: { data: [amount, "base64"] },
    }));
  const total = splAccounts + token2022Accounts + emptyAccounts;
  if (total > 32) throw new Error("tokenAccount() has 32 distinct addresses");
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    getTokenAccountsByOwner: (_owner, filter) => ({
      value:
        (filter as { programId: Address }).programId === TOKEN_PROGRAM_ADDRESS
          ? [
              ...accounts(splAccounts, 0),
              ...accounts(
                emptyAccounts,
                splAccounts + token2022Accounts,
                encode(0n)
              ),
            ]
          : accounts(token2022Accounts, splAccounts),
    }),
    getSignaturesForAddress: () => [],
  };
  const rpc = new Proxy(
    {},
    {
      get:
        (_, method: string) =>
        (...args: unknown[]) => {
          calls.push(method);
          const answer = answers[method];
          if (!answer) throw new Error(`unexpected RPC call ${method}`);
          return { send: async () => answer(...args) };
        },
    }
  ) as Rpc<SolanaRpcApi>;
  return { rpc, calls };
}

const owner = address("ET1aQ56Cz8fYsjCFgddfqeheAQpRLzX4skM8AsaYAQjx");

test("B1-011 S2: fetchActivity reports how many token accounts it read out of how many, with no extra RPC calls", async () => {
  // 9 SPL Token and 4 Token-2022 accounts: 13, three over the limit.
  const { rpc, calls } = stubRpc(9, 4);
  const result = await fetchActivity(rpc, owner);
  expect(result.tokenAccounts).toEqual({ read: MAX_TOKEN_ACCOUNTS, total: 13 });
  expect(result.activity).toEqual([]);
  // As before B1-011: two listings, then one lookup for the wallet and one
  // per token account read.
  expect(calls.sort()).toEqual(
    [
      ...Array(2).fill("getTokenAccountsByOwner"),
      ...Array(1 + MAX_TOKEN_ACCOUNTS).fill("getSignaturesForAddress"),
    ].sort()
  );
});

test("B1-011 S1: within the limit every token account is read and the counts match", async () => {
  const { rpc, calls } = stubRpc(3, 1);
  const result = await fetchActivity(rpc, owner);
  expect(result.tokenAccounts).toEqual({ read: 4, total: 4 });
  expect(calls.filter((c) => c === "getSignaturesForAddress")).toHaveLength(5);
  expect(calls).toHaveLength(7);
});

// B1-012: the warning counts only token accounts holding a balance.

test("B1-012 S1: with 4 accounts holding a balance and 20 empty, fetchActivity reports all 4 read, with no extra RPC calls", async () => {
  const { rpc, calls } = stubRpc(3, 1, 20);
  const result = await fetchActivity(rpc, owner);
  expect(result.tokenAccounts).toEqual({ read: MAX_TOKEN_ACCOUNTS, total: 24 });
  expect(result.fundedTokenAccounts).toEqual({ read: 4, total: 4 });
  expect(calls.sort()).toEqual(
    [
      ...Array(2).fill("getTokenAccountsByOwner"),
      ...Array(1 + MAX_TOKEN_ACCOUNTS).fill("getSignaturesForAddress"),
    ].sort()
  );
});

test("B1-012 S2: with 12 accounts holding a balance, fetchActivity reports 10 of 12 read, with no extra RPC calls", async () => {
  const { rpc, calls } = stubRpc(9, 3, 5);
  const result = await fetchActivity(rpc, owner);
  expect(result.tokenAccounts).toEqual({ read: MAX_TOKEN_ACCOUNTS, total: 17 });
  expect(result.fundedTokenAccounts).toEqual({
    read: MAX_TOKEN_ACCOUNTS,
    total: 12,
  });
  expect(calls).toHaveLength(2 + 1 + MAX_TOKEN_ACCOUNTS);
});

test("B1-012 S4: within the limit every account is read, those holding a balance included", async () => {
  const { rpc } = stubRpc(2, 1, 3);
  const result = await fetchActivity(rpc, owner);
  expect(result.tokenAccounts).toEqual({ read: 6, total: 6 });
  expect(result.fundedTokenAccounts).toEqual({ read: 3, total: 3 });
});

test("B1-012 S5: the reading order and the count agree on which accounts hold a balance", () => {
  // Amounts on both sides of every plausible threshold, including the
  // smallest balance (1) and the largest a u64 holds.
  const amounts = [0n, 1n, 2n, 5n, 2n ** 64n - 1n];
  expect(
    amounts.map((amount) => holdsBalance({ address: tokenAccount(0), amount }))
  ).toEqual([false, true, true, true, true]);
  // A deterministic spread of wallets: 0 to 31 accounts, amounts cycling with
  // different strides so funded and empty accounts interleave by address.
  for (let size = 0; size <= 31; size++) {
    for (const stride of [1, 2, 3, 7]) {
      const accounts = Array.from({ length: size }, (_, n) => ({
        address: tokenAccount(n),
        amount: amounts[(n * stride + size) % amounts.length],
      }));
      for (const cap of [0, 1, 4, MAX_TOKEN_ACCOUNTS, 31]) {
        const picked = pickTokenAccounts(accounts, cap);
        const counts = fundedCounts(accounts, picked);
        const funded = accounts.filter(holdsBalance);
        // The count uses the same rule as the order...
        expect(counts.total).toBe(funded.length);
        // ...and the order reads every account that rule calls funded before
        // any it calls empty, so an unread funded account exists only when
        // there are more funded accounts than the cap.
        expect(counts.read).toBe(Math.min(funded.length, cap));
        const firstEmpty = picked.findIndex(
          (a) => !funded.some((f) => f.address === a)
        );
        if (firstEmpty >= 0) expect(counts.read).toBe(firstEmpty);
      }
    }
  }
});
