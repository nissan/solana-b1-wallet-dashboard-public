"use client";

import useSWR from "swr";
import type { Address } from "@solana/kit";
import { useCluster } from "../../components/cluster-context";
import { useAppClient } from "../client-provider";
import { fetchHoldings } from "../holdings";

export function useHoldings(owner?: Address) {
  const { cluster } = useCluster();
  const client = useAppClient();
  const { data, error, isLoading, mutate } = useSWR(
    owner ? (["holdings", cluster, owner] as const) : null,
    ([, , o]) => fetchHoldings(client.rpc, o),
    // Token balances have no subscription here, and an RPC node's token index
    // can trail a just-confirmed transfer, so poll as well as refreshing after
    // each send.
    { refreshInterval: 10_000 }
  );
  return {
    holdings: data ?? null,
    error: error as Error | undefined,
    isLoading,
    refresh: mutate,
  };
}
