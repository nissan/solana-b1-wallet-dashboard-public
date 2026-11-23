import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ActivityCard } from "../app/components/activity-card";

// B1-011 S3: the card must take its number from MAX_TOKEN_ACCOUNTS. The
// constant is replaced with 7 here, a value no copy of the real limit (10)
// can match, so a card that hard-codes the number fails these tests.
vi.mock("../app/lib/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/activity")>()),
  MAX_TOKEN_ACCOUNTS: 7,
}));

type Counts = { read: number; total: number };
const state: {
  tokenAccounts: Counts | null;
  error?: Error;
  isLoading: boolean;
} = { tokenAccounts: null, isLoading: false };

vi.mock("../app/lib/hooks/use-activity", () => ({
  useActivity: () => ({
    activity: state.isLoading || state.error ? null : [],
    tokenAccounts: state.tokenAccounts,
    error: state.error,
    isLoading: state.isLoading,
    isRetrying: false,
    retry: () => {},
  }),
}));
vi.mock("../app/lib/client-provider", () => ({ useAppClient: () => ({}) }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({
  useConnectedWallet: () => null,
}));
vi.mock("../app/components/cluster-context", () => ({
  useCluster: () => ({ getExplorerUrl: (path: string) => path }),
}));

afterEach(() => {
  cleanup();
  Object.assign(state, {
    tokenAccounts: null,
    error: undefined,
    isLoading: false,
  });
});

const SCOPE =
  "The last 20 transactions for this wallet and up to 7 of its token accounts.";

function subtitle() {
  return screen.getByRole("heading", { name: "Recent activity" })
    .nextElementSibling?.textContent;
}

function warning() {
  return screen.queryByText(/token accounts were read/);
}

test("B1-011 S3: the line under the heading takes its number from MAX_TOKEN_ACCOUNTS", () => {
  state.tokenAccounts = { read: 3, total: 3 };
  render(<ActivityCard />);
  expect(subtitle()).toBe(SCOPE);
});

test("B1-011 S1: no warning when the wallet has no more token accounts than the limit", () => {
  state.tokenAccounts = { read: 7, total: 7 };
  render(<ActivityCard />);
  expect(subtitle()).toBe(SCOPE);
  expect(warning()).toBeNull();
});

test("B1-011 S2: above the limit the card says how many were read out of how many", () => {
  state.tokenAccounts = { read: 7, total: 10 };
  render(<ActivityCard />);
  expect(subtitle()).toBe(SCOPE);
  expect(warning()?.textContent).toBe(
    "Only 7 of this wallet's 10 token accounts were read, so a deposit into one of the other 3 may be missing."
  );
});

test("B1-011 S2: one unread token account is named in the singular", () => {
  state.tokenAccounts = { read: 7, total: 8 };
  render(<ActivityCard />);
  expect(warning()?.textContent).toBe(
    "Only 7 of this wallet's 8 token accounts were read, so a deposit into the other one may be missing."
  );
});

test("B1-011 S4: while loading or after an error the line stays and no count is guessed", () => {
  state.isLoading = true;
  render(<ActivityCard />);
  expect(subtitle()).toBe(SCOPE);
  expect(warning()).toBeNull();
  cleanup();

  state.isLoading = false;
  state.error = new Error("429");
  render(<ActivityCard />);
  expect(subtitle()).toBe(SCOPE);
  expect(warning()).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
