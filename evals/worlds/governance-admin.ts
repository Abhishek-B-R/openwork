import { allocateFreePort } from "@openwork/cdp";
import { needs, SkipError, type Seed } from "@openwork/env";
import { gatewayGovernanceOverviewSchema } from "@openwork/types/den/gateway-governance";

export async function governanceAdmin(seed: Seed) {
  needs({ placement: "local" });
  if (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) throw new SkipError("a disposable Den Web, not an attached service");
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    schema: "migrate",
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      GATEWAY_GOVERNANCE_MODE: "self_hosted_module",
      TYPESAFE_API_KEY: "governance-journey-not-a-real-credential",
      GATEWAY_GOVERNANCE_PROCESSING_APPROVED: "true",
      GATEWAY_GOVERNANCE_PASS_MAX: "0.1", GATEWAY_GOVERNANCE_BLOCK_MIN: "0.9",
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: "Governance Journey",
      admin: { name: "Governance Owner", email: "governance-owner@example.test" },
      members: { teammate: { name: "Governance Member", email: "governance-member@example.test" } },
    },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Expected a synthetic teammate session");
  const initial = await seed.api(den.admin, "/v1/gateway-governance");
  if (initial.response.status === 404) throw new SkipError("integrated governance management API and settings migration");
  if (!initial.response.ok) throw new Error(`Governance setup returned HTTP ${initial.response.status}`);
  const data = gatewayGovernanceOverviewSchema.parse(initial.body);
  if (!data.availability.available) throw new SkipError(`configured self-host governance fixture: ${data.availability.reason}`);
  if (data.settings.enabled || data.policies.length !== 0) throw new Error("Journey requires a fresh, disabled organization with no policies");
  const viewport = { width: 1440, height: 1100 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=governance", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard", headless: true, viewport });
  return { den, web, memberWeb, teammate };
}
