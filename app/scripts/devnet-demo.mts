// Seeds a devnet wallet so a reviewer can reproduce B1-002 S1 and S2:
// creates two SPL Token mints with Metaplex metadata (symbols B1USD and
// B1GEM), mints a balance of each to the owner, then reads the holdings back
// with the same code the dashboard uses.
//
//   DEVNET_PAYER_KEYPAIR=~/devnet-payer.json \
//     node scripts/devnet-demo.mts [--owner <wallet address>] [--rpc <url>]
//
// The payer is a solana-keygen JSON file holding devnet SOL (about 0.02 SOL
// is enough). It is read locally and never written anywhere. The script
// refuses any cluster whose genesis hash is not devnet, unless the RPC URL is
// a local validator. With HELIUS_API_KEY set it uses Helius devnet, since the
// public devnet endpoint rate-limits sends; only the RPC host is ever printed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  AccountRole,
  address,
  createClient,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { tokenProgram } from "@solana-program/token";
import { fetchHoldings } from "../app/lib/holdings.ts";
import { formatAmount } from "../app/lib/amount.ts";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const METADATA_PROGRAM = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

const TOKENS = [
  {
    name: "B1 Demo Dollar",
    symbol: "B1USD",
    decimals: 6,
    amount: 250_500_000n,
  },
  {
    name: "B1 Demo Gem",
    symbol: "B1GEM",
    decimals: 9,
    amount: 42_000_000_001n,
  },
];

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    rpc: { type: "string" },
  },
});
const rpcUrl =
  values.rpc ??
  (process.env.HELIUS_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`
    : "https://api.devnet.solana.com");
const keypairPath = process.env.DEVNET_PAYER_KEYPAIR;
if (!keypairPath) {
  throw new Error("Set DEVNET_PAYER_KEYPAIR to a funded devnet keypair file");
}

const rpc = createSolanaRpc(rpcUrl);
const isLocal = ["localhost", "127.0.0.1"].includes(new URL(rpcUrl).hostname);
const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS && !isLocal) {
  throw new Error(
    `Refusing to run: ${new URL(rpcUrl).host} is not devnet (genesis ${genesis})`
  );
}

const payer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(keypairPath, "utf8")) as number[])
);
const owner = values.owner ? address(values.owner) : payer.address;
const wsUrl = rpcUrl.replace(/^http/, "ws").replace(/:8899(\/|$)/, ":8900$1");

const client = createClient()
  .use((c) => ({ ...c, payer, identity: payer }))
  .use(solanaRpc({ rpcUrl, rpcSubscriptionsUrl: wsUrl }))
  .use(tokenProgram());

console.log(
  `Cluster ${isLocal ? "local" : "devnet"} (${new URL(rpcUrl).host}); payer ${payer.address}; owner ${owner}`
);
const explorer = (path: string) =>
  `https://explorer.solana.com/${path}?cluster=${isLocal ? "custom&customUrl=" + encodeURIComponent(rpcUrl) : "devnet"}`;

for (const token of TOKENS) {
  const mint = await generateKeyPairSigner();
  const created = await client.token.instructions
    .createMint({
      newMint: mint,
      decimals: token.decimals,
      mintAuthority: payer.address,
    })
    .sendTransaction();
  const metadata = await client.sendTransaction([
    await createMetadataInstruction(
      mint.address,
      payer,
      token.name,
      token.symbol
    ),
  ]);
  const minted = await client.token.instructions
    .mintToATA({
      mint: mint.address,
      owner,
      mintAuthority: payer,
      amount: token.amount,
      decimals: token.decimals,
    })
    .sendTransaction();
  console.log(`${token.symbol} mint ${mint.address}`);
  for (const [step, result] of [
    ["create", created],
    ["metadata", metadata],
    ["mint", minted],
  ] as const) {
    console.log(`  ${step}: ${explorer(`tx/${result.context.signature}`)}`);
  }
}

console.log("Holdings read back with the dashboard's fetchHoldings:");
for (const h of await fetchHoldings(rpc, owner)) {
  console.log(
    `  ${h.symbol ?? h.mint}: ${formatAmount(h.amount, h.decimals)} (${h.decimals} decimals)`
  );
}

// Metaplex Token Metadata CreateMetadataAccountV3 (discriminator 33) with
// DataV2 { name, symbol, uri: "", seller_fee_basis_points: 0, creators,
// collection, uses: None }, is_mutable: true, collection_details: None.
async function createMetadataInstruction(
  mint: Address,
  authority: TransactionSigner,
  name: string,
  symbol: string
): Promise<Instruction> {
  const encodeAddress = getAddressEncoder();
  const [metadata] = await getProgramDerivedAddress({
    programAddress: METADATA_PROGRAM,
    seeds: [
      getUtf8Encoder().encode("metadata"),
      encodeAddress.encode(METADATA_PROGRAM),
      encodeAddress.encode(mint),
    ],
  });
  const text = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length, true);
    out.set(bytes, 4);
    return out;
  };
  const parts = [
    Uint8Array.of(33),
    text(name),
    text(symbol),
    text(""),
    Uint8Array.of(0, 0), // seller_fee_basis_points
    Uint8Array.of(0, 0, 0), // creators, collection, uses: None
    Uint8Array.of(1), // is_mutable
    Uint8Array.of(0), // collection_details: None
  ];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, p) => (data.set(p, offset), offset + p.length), 0);
  return {
    programAddress: METADATA_PROGRAM,
    accounts: [
      { address: metadata, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      {
        address: authority.address,
        role: AccountRole.READONLY_SIGNER,
        signer: authority,
      },
      {
        address: authority.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: authority,
      },
      { address: authority.address, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  } as Instruction;
}
