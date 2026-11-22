import { address, type Signature } from "@solana/kit";
import { expect, test } from "vitest";
import {
  describe,
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
