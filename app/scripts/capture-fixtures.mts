// Refreshes the mainnet account fixtures the product tests load into an
// offline Surfnet (B1-009). Run by hand only, never in CI:
//
//   node scripts/capture-fixtures.mts [--rpc <mainnet url>]
//
// It reads public mainnet accounts with getMultipleAccounts at one slot and
// rewrites tests/fixtures/<name>.json with the address, lamports, owner,
// executable flag, base64 data, and the slot and date of the capture. It
// never signs or sends anything. Review the result with `git diff`.
//
// The default RPC is the public mainnet endpoint. A keyed URL may be passed
// with --rpc or MAINNET_RPC_URL; only its host is printed.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type Address,
} from "@solana/kit";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const METADATA_PROGRAM = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PYUSD = address("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo");

async function metadataPda(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: METADATA_PROGRAM,
    seeds: [
      getUtf8Encoder().encode("metadata"),
      getAddressEncoder().encode(METADATA_PROGRAM),
      getAddressEncoder().encode(mint),
    ],
  });
  return pda;
}

// Every mainnet account the product tests read. An account that does not
// exist on mainnet is recorded as absent, so the offline answer (null) is a
// captured fact rather than an accident.
//
// An executable program cannot be loaded with setAccount. For an upgradeable
// program the capture records the SHA-256 of its ELF from the programdata
// account, and `bundledAt` names the address where offline Surfnet already
// holds a copy; the test loader deploys that copy only if the hashes match.
const ACCOUNTS: {
  name: string;
  address: Address;
  why: string;
  bundledAt?: Address;
}[] = [
  {
    name: "memo-program",
    address: address("Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH"),
    why: "Memo program targeted by @solana-program/memo 0.15 (the app client installs its plugin)",
    // Surfnet 1.7.0 bundles SPL Memo v2 here; on 22 November 2026 its ELF
    // was byte-identical to the mainnet Memo4c2p… program.
    bundledAt: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  },
  { name: "usdc-mint", address: USDC, why: "USDC mint (SPL Token)" },
  {
    name: "usdc-metadata",
    address: await metadataPda(USDC),
    why: "USDC Metaplex metadata: symbol USDC",
  },
  {
    name: "pyusd-mint",
    address: PYUSD,
    why: "PYUSD mint (Token-2022 with the token-metadata extension)",
  },
  {
    name: "pyusd-metadata",
    address: await metadataPda(PYUSD),
    why: "PYUSD Metaplex metadata PDA, read before the Token-2022 extension",
  },
];

const { values } = parseArgs({
  options: { rpc: { type: "string" } },
});
const rpcUrl =
  values.rpc ??
  process.env.MAINNET_RPC_URL ??
  "https://api.mainnet-beta.solana.com";
const rpc = createSolanaRpc(rpcUrl);

const genesis = await rpc.getGenesisHash().send();
if (genesis !== MAINNET_GENESIS) {
  throw new Error(
    `${new URL(rpcUrl).host} is not mainnet (genesis ${genesis}); refusing`
  );
}

const { context, value } = await rpc
  .getMultipleAccounts(
    ACCOUNTS.map((a) => a.address),
    { encoding: "base64", commitment: "finalized" }
  )
  .send();
const capturedAt = new Date().toISOString();
const dir = join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures");
mkdirSync(dir, { recursive: true });

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAMDATA_HEADER = 45; // enum tag (4), slot (8), Option<authority> (33)

// The ELF hash of an upgradeable program, read at the same slot or later.
async function programElf(programAccount: Uint8Array) {
  const programData = getAddressDecoder().decode(
    programAccount.subarray(4, 36)
  );
  const { value: info } = await rpc
    .getAccountInfo(programData, {
      encoding: "base64",
      commitment: "finalized",
      minContextSlot: context.slot,
    })
    .send();
  if (!info) throw new Error(`programdata ${programData} not found`);
  const elf = Buffer.from(info.data[0], "base64").subarray(PROGRAMDATA_HEADER);
  return {
    programData,
    elfBytes: elf.length,
    elfSha256: createHash("sha256").update(elf).digest("hex"),
  };
}

for (const [i, account] of ACCOUNTS.entries()) {
  const info = value[i];
  let program;
  if (info?.executable) {
    if (info.owner !== UPGRADEABLE_LOADER || !account.bundledAt) {
      throw new Error(`${account.name}: no supported way to load this program`);
    }
    program = {
      ...(await programElf(Buffer.from(info.data[0], "base64"))),
      bundledAt: account.bundledAt,
    };
  }
  const fixture = {
    name: account.name,
    why: account.why,
    address: account.address,
    source: {
      cluster: "mainnet-beta",
      slot: Number(context.slot),
      capturedAt,
    },
    account: info
      ? {
          lamports: Number(info.lamports),
          owner: info.owner,
          executable: info.executable,
          data: info.data[0],
        }
      : null,
    ...(program ? { program } : {}),
  };
  writeFileSync(
    join(dir, `${account.name}.json`),
    JSON.stringify(fixture, null, 2) + "\n"
  );
  console.log(
    `${account.name} ${account.address} ${
      info ? `${info.data[0].length} base64 chars` : "absent on mainnet"
    }${program ? `, ELF sha256 ${program.elfSha256}` : ""}`
  );
}
console.log(
  `Captured ${ACCOUNTS.length} accounts from ${new URL(rpcUrl).host} at slot ${context.slot}`
);
