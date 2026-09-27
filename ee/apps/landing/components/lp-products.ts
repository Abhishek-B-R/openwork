import { Cloud, Monitor, Plug, Route, type LucideIcon } from "lucide-react";

export type LpProductKey = "mcp-gateway" | "ai-gateway" | "desktop-app" | "cloud-app";

export type LpProduct = {
  key: LpProductKey;
  name: string;
  href: string;
  /** Short fact shown on the right of the header menu row. */
  fact: string;
  /** One line shown under the name in the homepage Products row. */
  line: string;
  icon: LucideIcon;
};

export const LP_PRODUCTS: LpProduct[] = [
  {
    key: "mcp-gateway",
    name: "MCP Gateway",
    href: "/connect",
    fact: "Any MCP client",
    line: "One URL gives every agent your team's tools.",
    icon: Plug
  },
  {
    key: "ai-gateway",
    name: "AI Gateway",
    href: "/docs/ai-gateway/overview",
    fact: "50+ providers",
    line: "Connect providers once. Choose who uses which model.",
    icon: Route
  },
  {
    key: "desktop-app",
    name: "Desktop App",
    href: "/download",
    fact: "Free, open source",
    line: "Free and local-first on Mac, Windows and Linux.",
    icon: Monitor
  },
  {
    key: "cloud-app",
    name: "Cloud App",
    href: "/cloud",
    fact: "For teams",
    line: "Skills, models and access for the whole team.",
    icon: Cloud
  }
];
