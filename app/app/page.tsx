"use client";

import { ActionsPanel } from "./components/actions/actions-panel";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black tracking-tight">Wallet dashboard</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Connect a Wallet Standard wallet to see your SOL and SPL token balances
        and send a transfer. Devnet by default; switch networks from the header.
      </p>
      <ActionsPanel />
    </main>
  );
}
