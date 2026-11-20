import {
  address,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const TOKEN_2022_PROGRAM_ADDRESS = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const METADATA_PROGRAM_ADDRESS = address(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
const MAX_ACCOUNTS_PER_CALL = 100;
const FETCH_TIMEOUT_MS = 8_000;

export type Holding = {
  mint: Address;
  programId: Address;
  /** Base units summed over every token account the owner has for this mint. */
  amount: bigint;
  decimals: number;
  /** Metaplex or Token-2022 metadata symbol; null when the mint has none. */
  symbol: string | null;
};

type ParsedTokenAccount = {
  mint: string;
  tokenAmount: { amount: string; decimals: number };
};

/**
 * Reads every SPL Token and Token-2022 balance the owner holds above zero.
 * Gives up after FETCH_TIMEOUT_MS so a stalled RPC call surfaces as an error
 * (and an SWR retry) instead of an endless loading state.
 */
export async function fetchHoldings(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address
): Promise<Holding[]> {
  const abortSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const byMint = new Map<Address, Holding>();
  for (const programId of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    const { value } = await rpc
      .getTokenAccountsByOwner(
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" }
      )
      .send({ abortSignal });
    for (const { account } of value) {
      const info = account.data.parsed.info as ParsedTokenAccount;
      const mint = address(info.mint);
      const amount = BigInt(info.tokenAmount.amount);
      const existing = byMint.get(mint);
      if (existing) {
        existing.amount += amount;
      } else {
        byMint.set(mint, {
          mint,
          programId,
          amount,
          decimals: info.tokenAmount.decimals,
          symbol: null,
        });
      }
    }
  }

  const holdings = [...byMint.values()].filter((h) => h.amount > 0n);
  await attachSymbols(rpc, holdings, abortSignal);
  return holdings.sort((a, b) =>
    (a.symbol ?? a.mint).localeCompare(b.symbol ?? b.mint)
  );
}

/** Fills `symbol` from Metaplex metadata, then the Token-2022 metadata extension. */
export async function attachSymbols(
  rpc: Rpc<SolanaRpcApi>,
  holdings: Pick<Holding, "mint" | "programId" | "symbol">[],
  abortSignal: AbortSignal
) {
  const pdas = await Promise.all(
    holdings.map((h) => metaplexMetadataAddress(h.mint))
  );
  const metadata = await getAccountsBase64(rpc, pdas, abortSignal);
  holdings.forEach((holding, i) => {
    holding.symbol = parseMetaplexSymbol(metadata[i]);
  });

  const token2022 = holdings.filter(
    (h) => h.symbol === null && h.programId === TOKEN_2022_PROGRAM_ADDRESS
  );
  if (token2022.length === 0) return;
  const { value: mints } = await rpc
    .getMultipleAccounts(
      token2022.map((h) => h.mint),
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send({ abortSignal });
  token2022.forEach((holding, i) => {
    holding.symbol = parseToken2022Symbol(mints[i]?.data);
  });
}

async function metaplexMetadataAddress(mint: Address): Promise<Address> {
  const encodeAddress = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: METADATA_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("metadata"),
      encodeAddress.encode(METADATA_PROGRAM_ADDRESS),
      encodeAddress.encode(mint),
    ],
  });
  return pda;
}

async function getAccountsBase64(
  rpc: Rpc<SolanaRpcApi>,
  addresses: Address[],
  abortSignal: AbortSignal
): Promise<(Uint8Array | null)[]> {
  const out: (Uint8Array | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const { value } = await rpc
      .getMultipleAccounts(addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL), {
        encoding: "base64",
        commitment: "confirmed",
      })
      .send({ abortSignal });
    for (const account of value) {
      out.push(
        account && account.owner === METADATA_PROGRAM_ADDRESS
          ? new Uint8Array(getBase64Encoder().encode(account.data[0]))
          : null
      );
    }
  }
  return out;
}

// Metaplex Metadata v1: key (1) | update authority (32) | mint (32) |
// name (u32 length + bytes) | symbol (u32 length + bytes) | ...
// Strings are padded with NULs to a fixed width.
export function parseMetaplexSymbol(data: Uint8Array | null): string | null {
  if (!data || data.length < 69 || data[0] !== 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const readString = (offset: number) => {
    if (offset + 4 > data.length) return null;
    const length = view.getUint32(offset, true);
    const end = offset + 4 + length;
    if (end > data.length) return null;
    const text = new TextDecoder().decode(data.subarray(offset + 4, end));
    return { text: text.replace(/\0/g, "").trim(), end };
  };
  const name = readString(65);
  const symbol = name && readString(name.end);
  return symbol?.text || null;
}

function parseToken2022Symbol(data: unknown): string | null {
  const extensions = (
    data as { parsed?: { info?: { extensions?: unknown } } } | undefined
  )?.parsed?.info?.extensions;
  if (!Array.isArray(extensions)) return null;
  for (const ext of extensions) {
    const { extension, state } = ext as {
      extension?: string;
      state?: { symbol?: unknown };
    };
    if (extension === "tokenMetadata" && typeof state?.symbol === "string") {
      return state.symbol.trim() || null;
    }
  }
  return null;
}
