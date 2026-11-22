import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address, createSolanaRpc } from "@solana/kit";
import type { Surfnet } from "@solana/surfpool";

// Mainnet accounts the tests read, saved by `node scripts/capture-fixtures.mts`
// and loaded into an offline Surfnet (B1-009). Surfnet never fetches from
// mainnet, so an account without a fixture reads as absent.
export type AccountFixture = {
  name: string;
  why: string;
  address: string;
  source: { cluster: string; slot: number; capturedAt: string };
  /** null when the account did not exist on mainnet at the captured slot. */
  account: {
    lamports: number;
    owner: string;
    executable: boolean;
    data: string;
  } | null;
  /** For an upgradeable program: its mainnet ELF hash and a bundled copy. */
  program?: {
    programData: string;
    elfBytes: number;
    elfSha256: string;
    bundledAt: string;
  };
};

// A string, not `new URL(...)`: under jsdom the URL global is jsdom's, which
// Node's fileURLToPath rejects.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function readFixtures(dir = FIXTURE_DIR): AccountFixture[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")));
}

/**
 * Writes every fixture into the Surfnet, after checking that each address in
 * `required` has one. `setAccount` cannot mark an account executable, so a
 * program fixture is deployed from the copy offline Surfnet bundles at
 * `program.bundledAt`, and only if that copy's ELF hash matches the one
 * captured from mainnet.
 */
export async function loadFixtures(
  surfnet: Surfnet,
  required: readonly string[],
  fixtures: AccountFixture[] = readFixtures()
) {
  const byAddress = new Map(fixtures.map((f) => [f.address, f]));
  const missing = required.filter((a) => !byAddress.has(a));
  if (missing.length > 0) {
    throw new Error(
      `No mainnet fixture for ${missing.join(", ")}; add it to ` +
        "scripts/capture-fixtures.mts and run that script by hand"
    );
  }
  for (const fixture of fixtures) {
    const { account } = fixture;
    if (!account) continue;
    if (!account.executable) {
      surfnet.setAccount(
        fixture.address,
        account.lamports,
        Buffer.from(account.data, "base64"),
        account.owner
      );
      continue;
    }
    if (!fixture.program) {
      throw new Error(
        `${fixture.name}: executable accounts cannot be loaded with setAccount`
      );
    }
    const elf = await bundledElf(surfnet, fixture.program.bundledAt);
    const sha256 = createHash("sha256").update(elf).digest("hex");
    if (sha256 !== fixture.program.elfSha256) {
      throw new Error(
        `${fixture.name}: the program bundled at ${fixture.program.bundledAt} ` +
          `(sha256 ${sha256}) is not the captured mainnet ELF ` +
          `(sha256 ${fixture.program.elfSha256})`
      );
    }
    surfnet.deploy({ programId: fixture.address, soBytes: elf });
  }
}

async function bundledElf(surfnet: Surfnet, at: string): Promise<Buffer> {
  const { value } = await createSolanaRpc(surfnet.rpcUrl)
    .getAccountInfo(address(at), { encoding: "base64" })
    .send();
  if (!value?.executable) {
    throw new Error(`offline Surfnet has no bundled program at ${at}`);
  }
  return Buffer.from(value.data[0], "base64");
}
