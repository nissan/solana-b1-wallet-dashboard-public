const MAX_U64 = (1n << 64n) - 1n;

/** Parses a decimal string such as "1.5" into base units for `decimals`. */
export function parseAmount(text: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error("Enter an amount as a number, like 1.5");
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new Error(
      decimals === 0
        ? "This token has no decimal places"
        : `Use at most ${decimals} decimal places`
    );
  }
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error("Amount must be greater than zero");
  if (units > MAX_U64) throw new Error("Amount is too large");
  return units;
}

/** Formats base units as a decimal string without trailing zeros. */
export function formatAmount(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const grouped = whole.toLocaleString("en-US");
  return fraction ? `${grouped}.${fraction}` : grouped;
}
