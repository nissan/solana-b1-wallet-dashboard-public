import { address, createSolanaRpc } from "@solana/kit";
import { Surfnet } from "@solana/surfpool";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadFixtures, readFixtures, type AccountFixture } from "./fixtures";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO = "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH";
// A real mainnet mint (USDT) that has no fixture on purpose.
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

let surfnet: Surfnet;
let rpc: ReturnType<typeof createSolanaRpc>;

beforeAll(() => {
  surfnet = Surfnet.startWithConfig({ offline: true });
  rpc = createSolanaRpc(surfnet.rpcUrl);
});

afterAll(() => {
  surfnet?.stop();
});

test("B1-009: every committed fixture records its mainnet source slot and capture date", () => {
  const fixtures = readFixtures();
  expect(fixtures.length).toBeGreaterThan(0);
  for (const f of fixtures) {
    expect(f.source.cluster).toBe("mainnet-beta");
    expect(f.source.slot).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(f.source.capturedAt))).toBe(false);
    address(f.address);
  }
});

test("B1-009: loaded fixtures are served by the offline Surfnet byte for byte", async () => {
  await loadFixtures(surfnet, [USDC, MEMO]);
  const usdc = readFixtures().find((f) => f.address === USDC)!;
  const { value } = await rpc
    .getAccountInfo(address(USDC), { encoding: "base64" })
    .send();
  expect(value?.owner).toBe(usdc.account!.owner);
  expect(value?.data[0]).toBe(usdc.account!.data);
  expect(Number(value?.lamports)).toBe(usdc.account!.lamports);
  const memo = await rpc
    .getAccountInfo(address(MEMO), { encoding: "base64" })
    .send();
  expect(memo.value?.executable).toBe(true);
});

test("B1-009 S2: a mainnet account with no fixture is not fetched from mainnet", async () => {
  const { value } = await rpc
    .getAccountInfo(address(USDT), { encoding: "base64" })
    .send();
  expect(value).toBeNull();
});

test("B1-009 S2: a required account with no fixture is reported missing", async () => {
  await expect(loadFixtures(surfnet, [USDC, USDT])).rejects.toThrow(
    `No mainnet fixture for ${USDT}`
  );
});

const program: AccountFixture = {
  name: "some-program",
  why: "negative test",
  address: USDT,
  source: { cluster: "mainnet-beta", slot: 1, capturedAt: "2026-11-22" },
  account: { lamports: 1, owner: USDC, executable: true, data: "" },
};

test("B1-009: an executable fixture without a bundled copy is refused", async () => {
  await expect(loadFixtures(surfnet, [], [program])).rejects.toThrow(
    "some-program: executable accounts cannot be loaded with setAccount"
  );
});

test("B1-009: a bundled program whose ELF differs from the captured hash is not deployed", async () => {
  const mismatched: AccountFixture = {
    ...program,
    program: {
      programData: USDT,
      elfBytes: 2304,
      elfSha256: "0".repeat(64),
      bundledAt: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    },
  };
  await expect(loadFixtures(surfnet, [], [mismatched])).rejects.toThrow(
    "is not the captured mainnet ELF"
  );
  const { value } = await rpc
    .getAccountInfo(address(USDT), { encoding: "base64" })
    .send();
  expect(value).toBeNull();
});
