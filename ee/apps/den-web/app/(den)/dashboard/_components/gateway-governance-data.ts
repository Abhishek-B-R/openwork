"use client";

import {
  gatewayGovernanceDecisionListResponseSchema,
  gatewayGovernanceOverviewSchema,
  gatewayGovernancePolicySchema,
  gatewayGovernancePolicyWriteSchema,
  gatewayGovernancePolicyPatchSchema,
  gatewayGovernanceSettingsSchema,
  gatewayGovernanceSettingsPatchSchema,
  type GatewayGovernancePolicy,
  type GatewayGovernancePolicyWrite,
  type GatewayGovernanceSettingsPatch,
} from "@openwork/types/den/gateway-governance";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { isReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";

export const gatewayGovernancePath = "/v1/gateway-governance";
const policyResponseSchema = z.object({ policy: gatewayGovernancePolicySchema }).strict();
const settingsResponseSchema = z.object({ settings: gatewayGovernanceSettingsSchema }).strict();

export function gatewayGovernanceKey(orgId: string): string[] {
  return ["gateway-governance", orgId];
}

export const gatewayGovernanceDecisionPageSize = 25;

export function gatewayGovernanceDecisionsKey(orgId: string): string[] {
  return ["gateway-governance-decisions", orgId];
}

export class GatewayGovernanceRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 409
      ? "Governance changed since you opened it. Refresh the current state and review your changes before saving again."
      : status === 401 || status === 403
        ? "Governance access could not be verified. Ask a workspace owner to check your access, then refresh."
        : "Governance is unavailable. Refresh to verify the current state.");
  }
}

export class GatewayGovernanceWriteUncertainError extends Error {
  constructor() {
    super("This change may already have been saved. Refresh and review the current state before making another change.");
  }
}

async function requestGovernance<T>(orgId: string, path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
  const write = Boolean(init.method && init.method !== "GET");
  const { response, payload } = await requestJson(path, {
    ...init,
    method: init.method ?? "GET",
    headers: { [ORG_SCOPE_HEADER]: orgId },
    cache: "no-store",
  }, 15000).catch((error: unknown) => {
    if (isReauthRequiredError(error)) throw error;
    if (write) throw new GatewayGovernanceWriteUncertainError();
    throw new Error("Governance could not be verified. Refresh to try again.");
  });
  if (!response.ok) {
    if (write && (response.status >= 500 || response.status === 408)) throw new GatewayGovernanceWriteUncertainError();
    throw new GatewayGovernanceRequestError(response.status);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    if (write) throw new GatewayGovernanceWriteUncertainError();
    throw new Error("Governance returned an invalid response. Refresh to verify the current state.");
  }
  return parsed.data;
}

export function fetchGatewayGovernance(orgId: string, signal?: AbortSignal) {
  return requestGovernance(orgId, gatewayGovernancePath, gatewayGovernanceOverviewSchema, { signal });
}

export async function fetchGatewayGovernanceDecisions(orgId: string, cursor: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(gatewayGovernanceDecisionPageSize) });
  if (cursor) query.set("cursor", cursor);
  return requestGovernance(orgId, `${gatewayGovernancePath}/decisions?${query.toString()}`, gatewayGovernanceDecisionListResponseSchema, { signal })
    .catch((error: unknown) => {
      if (isReauthRequiredError(error)) throw error;
      throw new Error("Recent decisions could not be loaded. Try again.");
    });
}

const firstDecisionPage: string | null = null;

export function useGatewayGovernanceDecisions(orgId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: gatewayGovernanceDecisionsKey(orgId),
    queryFn: ({ pageParam, signal }) => fetchGatewayGovernanceDecisions(orgId, pageParam, signal),
    initialPageParam: firstDecisionPage,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useGatewayGovernance(orgId: string) {
  return useQuery({
    queryKey: gatewayGovernanceKey(orgId),
    queryFn: ({ signal }) => fetchGatewayGovernance(orgId, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export type GatewayGovernanceAction =
  | { type: "settings"; body: GatewayGovernanceSettingsPatch }
  | { type: "create"; body: GatewayGovernancePolicyWrite }
  | { type: "edit"; policy: Pick<GatewayGovernancePolicy, "id" | "revision">; body: GatewayGovernancePolicyWrite }
  | { type: "publish" | "archive"; policy: Pick<GatewayGovernancePolicy, "id" | "revision"> };

export async function mutateGatewayGovernance(orgId: string, action: GatewayGovernanceAction) {
  if (action.type === "settings") {
    return requestGovernance(orgId, `${gatewayGovernancePath}/settings`, settingsResponseSchema, {
      method: "PATCH", body: JSON.stringify(gatewayGovernanceSettingsPatchSchema.parse(action.body)),
    });
  }
  if (action.type === "create") {
    return requestGovernance(orgId, `${gatewayGovernancePath}/policies`, policyResponseSchema, {
      method: "POST", body: JSON.stringify(gatewayGovernancePolicyWriteSchema.parse(action.body)),
    });
  }
  const body = gatewayGovernancePolicyPatchSchema.parse({
    expectedRevision: action.policy.revision,
    ...(action.type === "edit" ? gatewayGovernancePolicyWriteSchema.parse(action.body) : { status: action.type === "publish" ? "active" : "archived" }),
  });
  return requestGovernance(orgId, `${gatewayGovernancePath}/policies/${encodeURIComponent(action.policy.id)}`, policyResponseSchema, {
    method: "PATCH", body: JSON.stringify(body),
  });
}

export function useGatewayGovernanceMutation(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...gatewayGovernanceKey(orgId), "write"],
    retry: false,
    networkMode: "always",
    mutationFn: async (action: GatewayGovernanceAction) => {
      await client.cancelQueries({ queryKey: gatewayGovernanceKey(orgId) });
      await mutateGatewayGovernance(orgId, action);
      const overview = await fetchGatewayGovernance(orgId).catch(() => {
        throw new GatewayGovernanceWriteUncertainError();
      });
      client.setQueryData(gatewayGovernanceKey(orgId), overview);
      return overview;
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: gatewayGovernanceKey(orgId) });
    },
  });
}
