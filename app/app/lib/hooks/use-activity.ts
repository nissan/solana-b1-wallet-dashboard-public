"use client";

import useSWR from "swr";
import type { Address } from "@solana/kit";
import { useCluster } from "../../components/cluster-context";
import { useAppClient } from "../client-provider";
import { fetchActivity } from "../activity";

export const activityKey = (cluster: string, owner: Address) =>
  ["activity", cluster, owner] as const;

export function useActivity(owner?: Address) {
  const { cluster } = useCluster();
  const client = useAppClient();
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    owner ? activityKey(cluster, owner) : null,
    ([, , o]) => fetchActivity(client.rpc, o),
    // No automatic retries: a rate-limited RPC should get a pause, and the
    // card offers a Retry button instead.
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  return {
    activity: data ?? null,
    error: error as Error | undefined,
    isLoading,
    isRetrying: isValidating && error != null,
    retry: () => mutate(),
  };
}
