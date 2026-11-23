import { MEMO_PROGRAM_ADDRESS } from "@solana-program/memo";
import {
  address,
  createClient,
  createSolanaRpc,
  generateKeyPairSigner,
  lamports,
  none,
  some,
  type Signature,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { systemProgram } from "@solana-program/system";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchMint,
  fetchToken,
  getMintEncoder,
  TOKEN_PROGRAM_ADDRESS,
  tokenProgram,
} from "@solana-program/token";
import { Surfnet } from "@solana/surfpool";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useMemo } from "react";
import { Toaster } from "sonner";
import { SWRConfig } from "swr";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { AirdropCard } from "../app/components/actions/airdrop-card";
import { SendCard } from "../app/components/actions/send-card";
import { TokenCard } from "../app/components/actions/token-card";
import { ClusterProvider } from "../app/components/cluster-context";
import { HoldingsCard } from "../app/components/holdings-card";
import { ActivityCard } from "../app/components/activity-card";
import { MAX_TOKEN_ACCOUNTS } from "../app/lib/activity";
import { ellipsify } from "../app/lib/explorer";
import { WalletButton } from "../app/components/wallet-button";
import { formatAmount } from "../app/lib/amount";
import { TOKEN_2022_PROGRAM_ADDRESS } from "../app/lib/holdings";
import { AppClientProvider } from "../app/lib/client-provider";
import { loadFixtures } from "./fixtures";
import {
  mockWalletAddress,
  registerMockWallet,
  resetMockWallet,
  signRequests,
} from "./mock-wallet";

// Mainnet mints, loaded into an offline Surfnet from committed fixtures with
// their real metadata (B1-009): USDC is an SPL Token mint with Metaplex
// metadata; PYUSD is a Token-2022 mint with the token-metadata extension.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

const LAMPORTS_PER_SOL = 1_000_000_000;

let surfnet: Surfnet;
let rpc: ReturnType<typeof createSolanaRpc>;
let lastSignature: Signature | undefined;

beforeAll(async () => {
  // Offline: no remote datasource, so no test can reach mainnet.
  surfnet = Surfnet.startWithConfig({ offline: true });
  await loadFixtures(surfnet, [USDC, PYUSD, MEMO_PROGRAM_ADDRESS]);
  rpc = createSolanaRpc(surfnet.rpcUrl);
  const memoProgram = await rpc
    .getAccountInfo(MEMO_PROGRAM_ADDRESS, { encoding: "base64" })
    .send();
  expect(memoProgram.value?.executable).toBe(true);
  registerMockWallet();
}, 60_000);

afterAll(() => {
  surfnet?.stop();
});

beforeEach(async () => {
  localStorage.clear();
  resetMockWallet();
  surfnet.fundSol(mockWalletAddress, 5 * LAMPORTS_PER_SOL);
  const signatures = await rpc
    .getSignaturesForAddress(address(mockWalletAddress), { limit: 1 })
    .send();
  lastSignature = signatures[0]?.signature;
});

afterEach(cleanup);

function TestApp({
  tokens = false,
  rpcUrl,
}: {
  tokens?: boolean;
  rpcUrl?: string;
}) {
  const urls = useMemo(
    () => ({
      rpcUrl: rpcUrl ?? surfnet.rpcUrl,
      rpcSubscriptionsUrl: surfnet.wsUrl,
    }),
    [rpcUrl]
  );
  return (
    // A fresh SWR cache per render keeps token balances from leaking between tests.
    <SWRConfig value={{ provider: () => new Map() }}>
      <ClusterProvider>
        <AppClientProvider urls={urls}>
          <WalletButton />
          {tokens ? (
            <TokenCard />
          ) : (
            <>
              <HoldingsCard />
              <ActivityCard />
              <SendCard />
              <AirdropCard />
            </>
          )}
          <Toaster />
        </AppClientProvider>
      </ClusterProvider>
    </SWRConfig>
  );
}

async function getBalance(owner: string): Promise<bigint> {
  const { value } = await rpc
    .getBalance(address(owner), { commitment: "confirmed" })
    .send();
  return value;
}

async function expectNewV1Transactions() {
  const signatures = await rpc
    .getSignaturesForAddress(address(mockWalletAddress), {
      commitment: "confirmed",
      limit: 100,
      ...(lastSignature ? { until: lastSignature } : {}),
    })
    .send();
  expect(signatures.length).toBeGreaterThan(0);
  const transactions = await Promise.all(
    signatures.map(async ({ signature }) => {
      const transaction = await rpc
        .getTransaction(signature, {
          commitment: "confirmed",
          encoding: "json",
          maxSupportedTransactionVersion: 1,
        })
        .send();
      expect(transaction?.version).toBe(1);
      expect(transaction?.meta?.err).toBeNull();
      return transaction;
    })
  );
  lastSignature = signatures[0].signature;
  return transactions;
}

async function connectWallet() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Wallet" })
  );
  fireEvent.click(await screen.findByRole("button", { name: "Mock Wallet" }));
  return await screen.findByRole("button", {
    name: `Wallet ${mockWalletAddress}`,
  });
}

test("connects the mock wallet and shows its on-chain balance", async () => {
  render(<TestApp />);

  const walletButton = await connectWallet();
  fireEvent.click(walletButton);

  await screen.findByText(mockWalletAddress);
  await waitFor(
    () => {
      const balance = screen.getByText("Balance").nextElementSibling;
      expect(balance?.textContent).toBe("5 SOL");
    },
    { timeout: 10_000 }
  );
});

test("airdrop button funds the connected wallet", async () => {
  render(<TestApp />);
  await connectWallet();

  const before = await getBalance(mockWalletAddress);
  fireEvent.click(screen.getByRole("button", { name: "Airdrop 1 SOL" }));

  await screen.findByText("Airdropped 1 SOL");
  await waitFor(async () => {
    expect(await getBalance(mockWalletAddress)).toBe(
      before + BigInt(LAMPORTS_PER_SOL)
    );
  });
});

async function tokenBalance(owner: string, mint: string, program?: string) {
  const ata = address(await surfnet.getAta(owner, mint, program));
  return (await rpc.getTokenAccountBalance(ata).send()).value;
}

function cell(id: string) {
  return screen.getByTestId(`balance-${id}`).textContent;
}

async function chooseAsset(name: string) {
  const trigger = screen.getByRole("combobox");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

function fillSend(recipient: string, amount: string) {
  fireEvent.change(screen.getByLabelText("Recipient address"), {
    target: { value: recipient },
  });
  fireEvent.change(screen.getByLabelText(/^Amount \(/), {
    target: { value: amount },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

test("S1: shows SOL and each SPL token balance with symbol and decimals from RPC", async () => {
  surfnet.setTokenBalance(mockWalletAddress, USDC, 12_345_678);
  surfnet.setTokenBalance(
    mockWalletAddress,
    PYUSD,
    2_500_000,
    TOKEN_2022_PROGRAM_ADDRESS
  );
  render(<TestApp />);
  await connectWallet();

  const usdc = await tokenBalance(mockWalletAddress, USDC);
  const pyusd = await tokenBalance(
    mockWalletAddress,
    PYUSD,
    TOKEN_2022_PROGRAM_ADDRESS
  );
  expect(usdc.decimals).toBe(6);
  expect(pyusd.decimals).toBe(6);
  await waitFor(
    () => {
      expect(cell("SOL")).toBe("5 SOL");
      expect(cell(USDC)).toBe(`${usdc.uiAmountString} USDC`);
      expect(cell(PYUSD)).toBe(`${pyusd.uiAmountString} PYUSD`);
    },
    { timeout: 30_000 }
  );
  expect(cell(USDC)).toBe("12.345678 USDC");
}, 45_000);

test("S2: sends SOL, links the confirmed signature and updates the balance without reload", async () => {
  const recipient = (await Surfnet.newKeypair()).publicKey;
  render(<TestApp />);
  await connectWallet();
  await waitFor(() => expect(cell("SOL")).toBe("5 SOL"), { timeout: 10_000 });

  fillSend(recipient, "1");
  await screen.findByText(/Confirmed: 1 SOL to/, {}, { timeout: 15_000 });
  expect(signRequests).toBe(1);

  const link = screen.getByRole("link", { name: /View transaction/ });
  const href = new URL(link.getAttribute("href")!);
  expect(href.origin).toBe("https://explorer.solana.com");
  expect(href.searchParams.get("cluster")).toBe("devnet");
  const signature = href.pathname.split("/").at(-1)!;
  const [transaction] = await expectNewV1Transactions();
  expect(transaction?.transaction.signatures[0]).toBe(signature);

  expect(await getBalance(recipient)).toBe(BigInt(LAMPORTS_PER_SOL));
  const after = await getBalance(mockWalletAddress);
  expect(after).toBeLessThan(BigInt(4 * LAMPORTS_PER_SOL) + 1n);
  await waitFor(
    () => expect(cell("SOL")).toBe(`${formatAmount(after, 9)} SOL`),
    {
      timeout: 10_000,
    }
  );
}, 40_000);

test("S2: sends an SPL token and refreshes its balance", async () => {
  surfnet.setTokenBalance(mockWalletAddress, USDC, 12_345_678);
  const recipient = (await Surfnet.newKeypair()).publicKey;
  render(<TestApp />);
  await connectWallet();
  await waitFor(() => expect(cell(USDC)).toBe("12.345678 USDC"), {
    timeout: 30_000,
  });

  await chooseAsset("USDC");
  expect(screen.getByLabelText("Amount (USDC)")).toBeTruthy();
  fillSend(recipient, "1.5");
  await screen.findByText(/Confirmed: 1\.5 USDC to/, {}, { timeout: 15_000 });
  expect(signRequests).toBe(1);

  expect((await tokenBalance(recipient, USDC)).amount).toBe("1500000");
  // Refreshed after the send, then by polling if the token index trails.
  await waitFor(() => expect(cell(USDC)).toBe("10.845678 USDC"), {
    timeout: 25_000,
  });
  await expectNewV1Transactions();
}, 60_000);

test("S3: blocks malformed recipients and amounts above the balance without asking the wallet to sign", async () => {
  surfnet.setTokenBalance(mockWalletAddress, USDC, 12_345_678);
  const recipient = (await Surfnet.newKeypair()).publicKey;
  render(<TestApp />);
  await connectWallet();
  await waitFor(() => expect(cell("SOL")).toBe("5 SOL"), { timeout: 10_000 });

  fillSend("not-a-solana-address", "1");
  await screen.findByText("Enter a valid Solana address");

  fillSend(recipient, "5");
  await screen.findByText(
    "Amount exceeds your balance of 4.99999 SOL after network fees"
  );

  fillSend(recipient, "0.0000000001");
  await screen.findByText("Use at most 9 decimal places");

  await waitFor(() => expect(cell(USDC)).toBe("12.345678 USDC"), {
    timeout: 30_000,
  });
  await chooseAsset("USDC");
  fillSend(recipient, "12.345679");
  await screen.findByText("Amount exceeds your balance of 12.345678 USDC");

  expect(signRequests).toBe(0);
  expect(await getBalance(recipient)).toBe(0n);
}, 60_000);

test("creates a mint, mints tokens, and transfers to new and existing token accounts", async () => {
  render(<TestApp tokens />);
  await connectWallet();
  fireEvent.click(
    screen.getByRole("button", { name: "Create mint (9 decimals)" })
  );
  await screen.findByText("Token mint created", {}, { timeout: 15_000 });

  const mintLink = screen
    .getAllByRole("link")
    .find((link) => link.getAttribute("href")?.includes("/address/"));
  expect(mintLink).toBeTruthy();
  const mint = address(
    new URL(mintLink!.getAttribute("href")!).pathname.split("/").at(-1)!
  );
  const created = await fetchMint(rpc, mint);
  expect(created.data.decimals).toBe(9);
  expect(created.data.supply).toBe(0n);
  expect(created.data.mintAuthority).toEqual({
    __option: "Some",
    value: mockWalletAddress,
  });
  await expectNewV1Transactions();

  fireEvent.click(screen.getByRole("button", { name: "Mint to my wallet" }));
  await screen.findByText(
    "Tokens minted to your wallet",
    {},
    { timeout: 15_000 }
  );
  const senderAta = address(await surfnet.getAta(mockWalletAddress, mint));
  expect((await fetchToken(rpc, senderAta)).data.amount).toBe(100_000_000_000n);
  expect((await fetchMint(rpc, mint)).data.supply).toBe(100_000_000_000n);
  await expectNewV1Transactions();

  const recipient = (await Surfnet.newKeypair()).publicKey;
  const recipientAta = address(await surfnet.getAta(recipient, mint));
  expect(
    (await rpc.getAccountInfo(recipientAta, { encoding: "base64" }).send())
      .value
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("Recipient address"), {
    target: { value: recipient },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer tokens" }));
  await waitFor(
    async () => {
      const received = await fetchToken(rpc, recipientAta);
      expect(received.data.amount).toBe(10_000_000_000n);
      expect(received.data.owner).toBe(recipient);
      expect(received.data.mint).toBe(mint);
      expect((await fetchToken(rpc, senderAta)).data.amount).toBe(
        90_000_000_000n
      );
    },
    { timeout: 15_000 }
  );

  await expectNewV1Transactions();

  // Repeat with an existing ATA and a fractional amount to catch scaling errors.
  fireEvent.change(screen.getByLabelText("Amount to transfer"), {
    target: { value: "0.000000001" },
  });
  const transferButton = await screen.findByRole("button", {
    name: "Transfer tokens",
  });
  await waitFor(() =>
    expect((transferButton as HTMLButtonElement).disabled).toBe(false)
  );
  fireEvent.click(transferButton);
  await waitFor(
    async () => {
      expect((await fetchToken(rpc, recipientAta)).data.amount).toBe(
        10_000_000_001n
      );
      expect((await fetchToken(rpc, senderAta)).data.amount).toBe(
        89_999_999_999n
      );
      expect((await fetchMint(rpc, mint)).data.supply).toBe(100_000_000_000n);
    },
    { timeout: 15_000 }
  );
  await waitFor(
    () =>
      expect(
        (
          screen.getByRole("button", {
            name: "Transfer tokens",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false),
    { timeout: 15_000 }
  );
  await expectNewV1Transactions();
}, 60_000);

function activityRows() {
  return screen
    .getByRole("region", { name: "Recent activity" })
    .querySelectorAll("li");
}

test("B1-004 S1: activity lists sends and receipts in plain words with explorer links", async () => {
  // A real incoming transfer: a funded keypair sends 0.5 SOL to the wallet.
  const sender = await generateKeyPairSigner();
  surfnet.fundSol(sender.address, 2 * LAMPORTS_PER_SOL);
  const senderClient = createClient()
    .use((c) => ({ ...c, payer: sender, identity: sender }))
    .use(
      solanaRpc({ rpcUrl: surfnet.rpcUrl, rpcSubscriptionsUrl: surfnet.wsUrl })
    )
    .use(systemProgram());
  const incoming = await senderClient.system.instructions
    .transferSol({
      source: sender,
      destination: address(mockWalletAddress),
      amount: lamports(500_000_000n),
    })
    .sendTransaction();
  surfnet.setTokenBalance(mockWalletAddress, USDC, 12_345_678);

  const recipient = (await Surfnet.newKeypair()).publicKey;
  render(<TestApp />);
  await connectWallet();
  await waitFor(() => expect(cell(USDC)).toBe("12.345678 USDC"), {
    timeout: 30_000,
  });

  fillSend(recipient, "1");
  await screen.findByText(/Confirmed: 1 SOL to/, {}, { timeout: 15_000 });
  await chooseAsset("USDC");
  fillSend(recipient, "2.5");
  await screen.findByText(/Confirmed: 2\.5 USDC to/, {}, { timeout: 15_000 });

  const expected = [
    `Sent 2.5 USDC to ${ellipsify(recipient)}`,
    `Sent 1 SOL to ${ellipsify(recipient)}`,
    `Received 0.5 SOL from ${ellipsify(sender.address)}`,
  ];
  // 30 s: twice the app's 15 s activity budget, so a load that uses all of
  // it still finishes inside the wait (B1-010).
  await waitFor(
    () => {
      const texts = [...activityRows()].map((li) => li.textContent ?? "");
      for (const line of expected) {
        expect(texts.some((t) => t.startsWith(line))).toBe(true);
      }
    },
    { timeout: 30_000 }
  );
  const incomingRow = [...activityRows()].find((li) =>
    li.textContent?.startsWith(expected[2])
  )!;
  const link = incomingRow.querySelector("a")!;
  expect(link.getAttribute("href")).toContain(
    `/tx/${incoming.context.signature}`
  );
}, 90_000);

test("B1-004 S2: a rate-limited activity RPC leaves balances working and offers a retry", async () => {
  // A proxy in front of Surfnet that answers 429 for the activity methods.
  let limited = true;
  const proxy: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    if (limited && /getSignaturesForAddress|getTransaction/.test(body)) {
      res
        .writeHead(429, { "content-type": "text/plain" })
        .end("Too Many Requests");
      return;
    }
    try {
      const upstream = await fetch(surfnet.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      res
        .writeHead(upstream.status, { "content-type": "application/json" })
        .end(await upstream.text());
    } catch {
      // Surfnet stops in afterAll while a balance poll may still be in flight.
      res.writeHead(502).end();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const { port } = proxy.address() as AddressInfo;
  try {
    render(<TestApp rpcUrl={`http://127.0.0.1:${port}`} />);
    await connectWallet();
    await waitFor(() => expect(cell("SOL")).toBe("5 SOL"), { timeout: 10_000 });
    await screen.findByText(
      /Could not load recent activity/,
      {},
      {
        timeout: 20_000,
      }
    );
    expect(cell("SOL")).toBe("5 SOL");

    limited = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // 30 s: twice the app's 15 s activity budget, so a load that uses all of
    // it still finishes inside the wait (B1-010).
    await waitFor(
      () => {
        expect(screen.queryByText(/Could not load recent activity/)).toBeNull();
        expect(
          activityRows().length > 0 ||
            screen.queryByText("No transactions yet.")
        ).toBeTruthy();
      },
      { timeout: 30_000 }
    );
  } finally {
    proxy.close();
  }
}, 60_000);

test("B1-010 S1: an RPC that never answers the activity calls gets Retry within 15 s while balances render", async () => {
  // A proxy in front of Surfnet that holds the activity calls open and never
  // answers them; every other call (balances included) is forwarded.
  const stalled: ServerResponse[] = [];
  let firstStalledAt: number | undefined;
  const proxy: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    if (/getSignaturesForAddress|getTransaction/.test(body)) {
      firstStalledAt ??= Date.now();
      stalled.push(res);
      return;
    }
    try {
      const upstream = await fetch(surfnet.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      res
        .writeHead(upstream.status, { "content-type": "application/json" })
        .end(await upstream.text());
    } catch {
      res.writeHead(502).end();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const { port } = proxy.address() as AddressInfo;
  try {
    render(<TestApp rpcUrl={`http://127.0.0.1:${port}`} />);
    await connectWallet();
    await waitFor(() => expect(cell("SOL")).toBe("5 SOL"), { timeout: 10_000 });
    // 15 s budget plus a 2 s margin for rendering; well under the 25 s
    // budget B1-008 used, so the old budget fails here.
    await screen.findByText(
      /Could not load recent activity/,
      {},
      { timeout: 20_000 }
    );
    const elapsed = Date.now() - firstStalledAt!;
    expect(elapsed).toBeLessThan(17_000);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(cell("SOL")).toBe("5 SOL");
  } finally {
    for (const res of stalled) res.destroy();
    proxy.closeAllConnections();
    proxy.close();
  }
}, 60_000);

test("B1-008 S1: an incoming token transfer that names only the wallet's token account is listed", async () => {
  // The wallet already holds USDC, so its associated token account exists.
  surfnet.setTokenBalance(mockWalletAddress, USDC, 12_345_678);
  const walletAta = address(await surfnet.getAta(mockWalletAddress, USDC));

  // A different, freshly funded wallet sends it 1.25 USDC with a plain
  // TransferChecked: source, mint, destination token account and authority.
  // No associated-token-account creation, so the wallet address is not in
  // the transaction.
  const sender = await generateKeyPairSigner();
  surfnet.fundSol(sender.address, 2 * LAMPORTS_PER_SOL);
  surfnet.setTokenBalance(sender.address, USDC, 5_000_000);
  const senderAta = address(await surfnet.getAta(sender.address, USDC));
  const senderClient = createClient()
    .use((c) => ({ ...c, payer: sender, identity: sender }))
    .use(
      solanaRpc({ rpcUrl: surfnet.rpcUrl, rpcSubscriptionsUrl: surfnet.wsUrl })
    )
    .use(tokenProgram());
  const incoming = await senderClient.token.instructions
    .transferChecked({
      source: senderAta,
      mint: address(USDC),
      destination: walletAta,
      authority: sender,
      amount: 1_250_000n,
      decimals: 6,
    })
    .sendTransaction();
  const signature = incoming.context.signature;

  const sent = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 1,
    })
    .send();
  expect(sent?.meta?.err).toBeNull();
  const keys = sent!.transaction.message.accountKeys.map(String);
  expect(keys).toContain(walletAta);
  expect(keys).not.toContain(mockWalletAddress);
  expect((await tokenBalance(mockWalletAddress, USDC)).amount).toBe("13595678");

  render(<TestApp />);
  await connectWallet();
  await waitFor(() => expect(cell(USDC)).toBe("13.595678 USDC"), {
    timeout: 30_000,
  });

  const expected = `Received 1.25 USDC from ${ellipsify(sender.address)}`;
  // 30 s: twice the app's 15 s activity budget, so a load that uses all of
  // it still finishes inside the wait (B1-010).
  await waitFor(
    () => {
      const texts = [...activityRows()].map((li) => li.textContent ?? "");
      expect(texts.some((t) => t.startsWith(expected))).toBe(true);
    },
    { timeout: 30_000 }
  );
  const row = [...activityRows()].find((li) =>
    li.textContent?.startsWith(expected)
  )!;
  expect(row.querySelector("a")!.getAttribute("href")).toContain(
    `/tx/${signature}`
  );
}, 90_000);

// B1-011: the line under the Recent activity heading, with the number taken
// from the constant the reads use.
const ACTIVITY_SCOPE = `The last 20 transactions for this wallet and up to ${MAX_TOKEN_ACCOUNTS} of its token accounts.`;

/** SPL Token and Token-2022 accounts the wallet owns, read from Surfnet. */
async function countTokenAccounts(owner: string): Promise<number> {
  const lists = await Promise.all(
    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          address(owner),
          { programId },
          { encoding: "base64", commitment: "confirmed" }
        )
        .send()
    )
  );
  return lists.reduce((n, { value }) => n + value.length, 0);
}

/**
 * The wallet's token accounts holding a balance, read from Surfnet (B1-012).
 * Decodes the amount itself (u64 at byte 64) rather than using the app's code.
 */
async function countFundedTokenAccounts(owner: string): Promise<number> {
  const lists = await Promise.all(
    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          address(owner),
          { programId },
          { encoding: "base64", commitment: "confirmed" }
        )
        .send()
    )
  );
  return lists
    .flatMap(({ value }) => value)
    .filter(({ account }) => {
      const data = Buffer.from(account.data[0], "base64");
      return data.readBigUInt64LE(64) > 0n;
    }).length;
}

/** Creates `count` new SPL Token mints and gives the wallet `amount` of each. */
async function addTokenAccounts(count: number, amount: number) {
  const mint = getMintEncoder();
  for (let i = 0; i < count; i++) {
    const { address: mintAddress } = await generateKeyPairSigner();
    surfnet.setAccount(
      mintAddress,
      1_461_600,
      new Uint8Array(
        mint.encode({
          mintAuthority: some(address(mockWalletAddress)),
          supply: 1_000_000n,
          decimals: 6,
          isInitialized: true,
          freezeAuthority: none(),
        })
      ),
      TOKEN_PROGRAM_ADDRESS
    );
    surfnet.setTokenBalance(mockWalletAddress, mintAddress, amount);
  }
}

async function loadedActivityCard() {
  const card = screen.getByRole("region", { name: "Recent activity" });
  // 30 s: twice the app's 15 s activity budget (B1-010).
  await waitFor(
    () =>
      expect(
        activityRows().length > 0 ||
          within(card).queryByText("No transactions yet.")
      ).toBeTruthy(),
    { timeout: 30_000 }
  );
  return card;
}

test("B1-011 S1: the card says it reads up to 10 token accounts, and gives no warning within the limit", async () => {
  surfnet.setTokenBalance(mockWalletAddress, USDC, 12_345_678);
  const total = await countTokenAccounts(mockWalletAddress);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(MAX_TOKEN_ACCOUNTS);

  render(<TestApp />);
  await connectWallet();
  const card = await loadedActivityCard();
  expect(
    within(card).getByRole("heading").nextElementSibling?.textContent
  ).toBe(ACTIVITY_SCOPE);
  // /were read/ matches the B1-011 and the B1-012 warning wording.
  expect(within(card).queryByText(/were read/)).toBeNull();
}, 60_000);

test("B1-012 S1: a wallet over the limit only with empty token accounts gets no warning", async () => {
  const fundedBefore = await countFundedTokenAccounts(mockWalletAddress);
  expect(fundedBefore).toBeLessThanOrEqual(MAX_TOKEN_ACCOUNTS);
  // MAX_TOKEN_ACCOUNTS + 3 new SPL Token accounts holding nothing.
  await addTokenAccounts(MAX_TOKEN_ACCOUNTS + 3, 0);
  const total = await countTokenAccounts(mockWalletAddress);
  expect(total).toBeGreaterThanOrEqual(MAX_TOKEN_ACCOUNTS + 3);
  expect(await countFundedTokenAccounts(mockWalletAddress)).toBe(fundedBefore);

  render(<TestApp />);
  await connectWallet();
  const card = await loadedActivityCard();
  expect(
    within(card).getByRole("heading").nextElementSibling?.textContent
  ).toBe(ACTIVITY_SCOPE);
  expect(within(card).queryByText(/were read/)).toBeNull();
}, 60_000);

// Last in the file: it leaves the wallet above the limit for any test after it.
// Replaces the B1-011 S2 Surfnet test: the warning now counts only token
// accounts holding a balance (B1-012).
test("B1-012 S2: a wallet with more token accounts holding a balance than the limit is told how many of those were read", async () => {
  // MAX_TOKEN_ACCOUNTS + 3 new SPL Token mints, each with a balance in the
  // wallet's associated token account, so the wallet is over the limit
  // whatever earlier tests left behind.
  await addTokenAccounts(MAX_TOKEN_ACCOUNTS + 3, 1_000_000);
  const funded = await countFundedTokenAccounts(mockWalletAddress);
  expect(funded).toBeGreaterThanOrEqual(MAX_TOKEN_ACCOUNTS + 3);

  render(<TestApp />);
  await connectWallet();
  const card = await loadedActivityCard();
  expect(
    within(card).getByRole("heading").nextElementSibling?.textContent
  ).toBe(ACTIVITY_SCOPE);
  expect(within(card).getByText(/were read/).textContent).toBe(
    `Only ${MAX_TOKEN_ACCOUNTS} of this wallet's ${funded} token accounts holding a balance were read, so a deposit into one of the other ${funded - MAX_TOKEN_ACCOUNTS} may be missing.`
  );
}, 60_000);
