"use client";

import { useSyncExternalStore } from "react";
import {
  useConnectedWallet,
  useIsWalletReady,
} from "@solana/kit-plugin-wallet/react";
import { useAppClient } from "../../lib/client-provider";
import { useCluster } from "../cluster-context";
import { AirdropCard } from "./airdrop-card";
import { SendCard } from "./send-card";
import { TokenCard } from "./token-card";
import { HoldingsCard } from "../holdings-card";
import { ActivityCard } from "../activity-card";

const subscribeToHydration = () => () => {};

export function ActionsPanel() {
  const client = useAppClient();
  const connected = useConnectedWallet(client);
  const isWalletReady = useIsWalletReady(client);
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  const { cluster } = useCluster();

  if (!isHydrated || !isWalletReady) {
    return (
      <div
        className="mt-8 rounded-2xl border border-border-low bg-card p-6 text-sm text-muted"
        role="status"
      >
        Restoring wallet connection...
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="mt-8 rounded-2xl border border-border-low bg-card p-6 text-sm text-muted">
        Connect a wallet to see your balances and send a transfer.
      </div>
    );
  }

  const supportsV1 = connected.supportedTransactionVersions.has(1);

  return (
    <section className="mt-8 grid gap-4 sm:grid-cols-2">
      {cluster === "mainnet" && (
        <p className="sm:col-span-2 rounded-lg border border-border-low bg-card px-4 py-3 text-sm text-muted">
          Mainnet transactions use real SOL and tokens. Review every wallet
          prompt before signing.
        </p>
      )}
      <HoldingsCard />
      <ActivityCard />
      {connected.signer && supportsV1 ? (
        <>
          <SendCard key={`${cluster}:${connected.account.address}`} />
          {cluster !== "mainnet" && <AirdropCard />}
          {cluster !== "mainnet" && (
            <TokenCard key={`${cluster}:${connected.account.address}`} />
          )}
        </>
      ) : (
        <p className="sm:col-span-2 rounded-lg border border-border-low bg-card px-4 py-3 text-sm text-muted">
          {!connected.signer
            ? "This wallet account is connected in read-only mode and cannot sign transactions. Connect a signing-capable account to use these actions."
            : "This wallet does not support Version 1 transactions. Connect a V1-capable wallet to use these actions."}
        </p>
      )}
    </section>
  );
}
