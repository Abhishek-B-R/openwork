"use client";

import { BarChart3, Globe, LayoutGrid, Lock, Plug, Route, Shield, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { LpCopyButton, LpCopyIcon } from "./lp-copy";
import { LpDemoDesktop } from "./lp-demo-desktop";
import { MCP_CLIENTS, MCP_SERVER_URL } from "./lp-mcp-clients";
import { GoogleDriveMark, LinearMark, SkillMark, SlackMark } from "./lp-service-marks";
import { OpenWorkMark } from "./openwork-mark";

/* ------------------------------------------------------------------ */
/* MCP Gateway                                                         */
/* ------------------------------------------------------------------ */

type SharedItem = { mark: ReactNode; name: string; kind: string; who: string };

const SHARED: SharedItem[] = [
  { mark: <SkillMark className="h-[18px] w-[18px]" />, name: "Weekly update", kind: "Skill", who: "Everyone" },
  { mark: <SkillMark className="h-[18px] w-[18px]" />, name: "Brand voice", kind: "Skill", who: "Marketing" },
  { mark: <LinearMark className="h-[18px] w-[18px]" />, name: "Linear", kind: "Connection", who: "Everyone" },
  { mark: <GoogleDriveMark className="h-[18px] w-[18px]" />, name: "Google Drive", kind: "Connection", who: "Everyone" },
  { mark: <SlackMark className="h-[18px] w-[18px]" />, name: "Slack", kind: "Connection", who: "Everyone" }
];

export function LpDemoMcp() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      <div className="flex flex-col px-5 py-6 md:w-[600px] md:shrink-0 md:border-r md:border-[#F0F1F3] md:px-8 md:py-7">
        <span className="text-[13px] font-medium text-[#111827]">Connect any agent</span>
        <div className="mt-3 flex h-12 items-center gap-2.5 rounded-xl pl-4 pr-1.5 shadow-[0_0_0_1px_#E5E7EB]">
          <code className="mono min-w-0 flex-1 truncate text-[13px] text-[var(--lp-ink)] sm:text-sm">{MCP_SERVER_URL}</code>
          <LpCopyButton value={MCP_SERVER_URL} />
        </div>
        <ul className="mt-5 flex flex-col">
          {MCP_CLIENTS.filter((client) => client.id !== "gemini").map((client) => (
            <li key={client.id} className="flex h-12 items-center gap-3 border-b border-[#F0F1F3]">
              <span className="flex w-4 shrink-0">{client.mark}</span>
              <span className="w-[104px] shrink-0 text-sm font-medium text-[#111827]">{client.name}</span>
              {client.link ? (
                <span className="flex flex-1 justify-end">
                  <a href={client.link.href} className="lp-pill-secondary lp-pill-sm !h-[30px] !px-3 !text-xs">
                    {client.link.label}
                  </a>
                </span>
              ) : client.command ? (
                <span className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-[#F5F7FA] pl-2.5">
                  <code className="mono min-w-0 flex-1 truncate text-[11.5px] text-[#1F2937]">{client.command}</code>
                  <LpCopyIcon value={client.command} label={`Copy the ${client.name} command`} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-1 flex-col bg-[#FAFBFC] px-5 py-6 md:px-8 md:py-7">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-[#111827]">Shared with Acme Studio</span>
          <span className="text-xs text-[#6B7280]">Shows up in every agent</span>
        </div>
        <ul className="mt-3 flex flex-col">
          {SHARED.map((item) => (
            <li key={item.name} className="flex h-11 items-center gap-3 border-b border-[#EEF0F3]">
              <span className="flex w-[18px] shrink-0">{item.mark}</span>
              <span className="flex-1 text-[13px] font-medium text-[#111827]">{item.name}</span>
              <span className="w-[76px] shrink-0 text-xs text-[#6B7280]">{item.kind}</span>
              <span className="w-[76px] shrink-0 text-right text-xs text-[#374151]">{item.who}</span>
            </li>
          ))}
        </ul>
        <div className="mono mt-5 flex flex-col gap-2 rounded-xl bg-white p-4 text-xs leading-[18px] shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
          <span className="text-[#8A93A0]">claude</span>
          <span className="text-[var(--lp-ink)]">&gt; Draft this week&apos;s update for #launch</span>
          <span className="text-[#047857]">● openwork · Used Weekly update skill</span>
          <span className="text-[#047857]">● openwork · Searched issues · Linear</span>
          <span className="text-[var(--lp-ink)]">Draft ready: 23 issues closed this week…</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI Gateway                                                          */
/* ------------------------------------------------------------------ */

type Provider = { mark: ReactNode; name: string; models: string; who: string };

const PROVIDERS: Provider[] = [
  { mark: <BrandLogo name="anthropic" className="h-[18px] w-[18px] text-[#191919]" />, name: "Anthropic", models: "Claude Opus, Sonnet, Haiku", who: "Everyone" },
  { mark: <BrandLogo name="openai" className="h-[18px] w-[18px] text-[#111]" />, name: "OpenAI", models: "GPT-5, GPT-5 mini", who: "Engineering" },
  { mark: <BrandLogo name="aws" className="h-[18px] w-[18px] text-[#232F3E]" />, name: "Amazon Bedrock", models: "Claude, Llama", who: "Everyone" },
  { mark: <BrandLogo name="gemini" className="h-[18px] w-[18px] text-[#4285F4]" />, name: "Google Vertex AI", models: "Gemini 3 Pro", who: "Research" },
  { mark: <BrandLogo name="openrouter" className="h-[18px] w-[18px] text-[#6467F2]" />, name: "OpenRouter", models: "DeepSeek V4 Pro, Kimi K2", who: "Engineering" }
];

type Limit = { who: string; used: string; amount: string; percent: number };

const LIMITS: Limit[] = [
  { who: "Everyone", used: "$31 avg", amount: "$50 / person", percent: 62 },
  { who: "Engineering", used: "$1,180", amount: "$1,500", percent: 79 },
  { who: "Design team", used: "$276", amount: "$300", percent: 92 }
];

export function LpDemoAiGateway() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      <div className="flex flex-1 flex-col px-5 py-6 md:px-8 md:py-7">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-[#111827]">AI Providers</span>
          <span className="flex h-[30px] items-center rounded-lg bg-[var(--lp-ink)] px-3 text-xs text-white">Add provider</span>
        </div>
        <div className="mt-3.5 hidden h-7 items-center gap-3 border-b border-[var(--lp-border)] text-[11px] text-[#6B7280] sm:flex">
          <span className="w-[18px]" />
          <span className="w-[130px]">Provider</span>
          <span className="flex-1">Models</span>
          <span className="w-[100px]">Who can use</span>
          <span className="w-[60px]" />
        </div>
        <ul className="flex flex-col">
          {PROVIDERS.map((provider) => (
            <li key={provider.name} className="flex h-[52px] items-center gap-3 border-b border-[#F0F1F3]">
              <span className="flex w-[18px] shrink-0">{provider.mark}</span>
              <span className="w-[130px] shrink-0 text-[13px] font-medium text-[#111827]">{provider.name}</span>
              <span className="hidden flex-1 truncate text-xs text-[#4B5563] sm:block">{provider.models}</span>
              <span className="w-[100px] shrink-0 text-xs text-[#374151]">{provider.who}</span>
              <span className="flex w-[60px] shrink-0 items-center justify-end gap-1.5 text-xs text-[#047857]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-status-dot)]" aria-hidden="true" />
                Ready
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#F5F7FA] px-4 py-3.5">
          <span className="flex flex-col">
            <span className="text-[13px] font-medium text-[#111827]">Who can use models</span>
            <span className="text-xs text-[#4B5563]">Members can&apos;t add their own keys.</span>
          </span>
          <span className="flex h-[30px] items-center rounded-lg bg-white px-3 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">Only models you provide</span>
        </div>
      </div>
      <div className="flex flex-col bg-[#FAFBFC] px-5 py-6 md:w-[380px] md:shrink-0 md:border-l md:border-[#F0F1F3] md:px-8 md:py-7">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-[#111827]">Spend limits</span>
          <span className="text-xs text-[#6B7280]">This month</span>
        </div>
        <span className="mt-3.5 text-[32px] font-medium tracking-[-0.03em] text-[var(--lp-ink)]">$3,240</span>
        <span className="text-xs text-[#4B5563]">Spent by 48 people. Keys stay on the server.</span>
        <ul className="mt-3 flex flex-col">
          {LIMITS.map((limit) => (
            <li key={limit.who} className="flex flex-col gap-1.5 border-b border-[#EEF0F3] py-3">
              <span className="flex justify-between text-xs">
                <span className="font-medium text-[#111827]">{limit.who}</span>
                <span className="text-[#4B5563]">{limit.used} of {limit.amount}</span>
              </span>
              <span className="h-1.5 rounded-full bg-[#E8ECF1]">
                <span
                  className={`block h-1.5 rounded-full ${limit.percent > 85 ? "bg-[#B45309]" : "bg-[var(--lp-ink)]"}`}
                  style={{ width: `${limit.percent}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
        <span className="mt-3 text-xs text-[#6B7280]">Design team gets a warning at 90%. Pauses at 100%.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cloud App                                                           */
/* ------------------------------------------------------------------ */

type BrowserTab = "web" | "admin";

export function LpDemoCloud() {
  const [tab, setTab] = useState<BrowserTab>("web");
  const url = tab === "web" ? "app.openworklabs.com/acme-studio/web" : "app.openworklabs.com/acme-studio/policies";

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 bg-[#E9EBEE]">
        <div className="flex h-10 items-end gap-1 px-3" role="group" aria-label="Browser tabs">
          <span className="hidden h-8 items-center gap-[7px] pl-1 pr-2.5 sm:flex" aria-hidden="true">
            <span className="h-[11px] w-[11px] rounded-full bg-[#FF5F57]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#FEBC2E]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#28C840]" />
          </span>
          <BrowserTabButton selected={tab === "web"} onSelect={() => setTab("web")} label="OpenWork Web" />
          <BrowserTabButton selected={tab === "admin"} onSelect={() => setTab("admin")} label="Admin · Acme Studio" />
        </div>
        <div className="flex h-10 items-center border-b border-[#EEF0F3] bg-white px-3">
          <span className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[#F3F4F6] px-3 text-xs text-[#374151]">
            <Lock size={12} className="shrink-0 text-[#6B7280]" aria-hidden="true" />
            <span className="truncate">{url}</span>
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {tab === "web" ? (
          <LpDemoDesktop windowControls={false} locationLabel="Cloud computer" locationIcon="cloud" />
        ) : (
          <CloudAdmin />
        )}
      </div>
    </div>
  );
}

function BrowserTabButton({ selected, onSelect, label }: { selected: boolean; onSelect: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex h-8 min-w-0 items-center gap-2 rounded-t-lg px-3 text-xs transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--lp-ink)] sm:w-[210px] ${selected ? "bg-white text-[#111827]" : "text-[#4B5563] hover:bg-[#F1F2F4]"}`}
    >
      <OpenWorkMark className="h-3 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

type AdminNav = { icon: ReactNode; label: string };

const ADMIN_NAV: AdminNav[] = [
  { icon: <Globe size={16} strokeWidth={1.5} />, label: "Web" },
  { icon: <LayoutGrid size={16} strokeWidth={1.5} />, label: "Library" },
  { icon: <Plug size={16} strokeWidth={1.5} />, label: "MCP Gateway" },
  { icon: <Route size={16} strokeWidth={1.5} />, label: "AI Gateway" },
  { icon: <Users size={16} strokeWidth={1.5} />, label: "Members" },
  { icon: <Shield size={16} strokeWidth={1.5} />, label: "Policies" },
  { icon: <BarChart3 size={16} strokeWidth={1.5} />, label: "Analytics" }
];

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`flex h-[18px] w-8 items-center rounded-full p-0.5 ${on ? "justify-end bg-[var(--lp-ink)]" : "justify-start bg-[#D1D5DB]"}`} aria-hidden="true">
      <span className="h-3.5 w-3.5 rounded-full bg-white" />
    </span>
  );
}

function Select({ children }: { children: ReactNode }) {
  return <span className="flex h-7 items-center rounded-lg px-2.5 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">{children}</span>;
}

type Policy = { label: string; value: ReactNode };

const POLICIES: Policy[] = [
  { label: "Sign in with Okta", value: <span className="flex items-center gap-2.5 text-xs text-[#374151]">Required <Toggle on /></span> },
  { label: "Models members can use", value: <Select>Only models you provide</Select> },
  { label: "Who can share skills with everyone", value: <Select>Admins</Select> },
  {
    label: "Local MCP servers on desktops",
    value: (
      <span className="flex items-center gap-1.5 text-xs text-[#374151]">
        <Lock size={12} aria-hidden="true" /> Blocked for members
      </span>
    )
  },
  { label: "Automations on cloud computers", value: <span className="flex items-center gap-2.5 text-xs text-[#374151]">Allowed <Toggle on /></span> },
  { label: "Keep chat history", value: <span className="flex items-center gap-2.5 text-xs text-[#374151]">90 days <Toggle on /></span> }
];

function CloudAdmin() {
  return (
    <div className="flex min-h-0 w-full">
      <aside className="hidden w-[220px] shrink-0 flex-col gap-0.5 border-r border-[#EEF0F3] bg-[#F7F8FA] px-2.5 py-4 md:flex" aria-label="Admin sidebar">
        <div className="mb-2.5 flex h-10 items-center gap-2.5 px-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--lp-ink)] text-[11px] font-semibold text-white">A</span>
          <span className="flex flex-col leading-tight">
            <span className="text-[13px] font-medium text-[#111827]">Acme Studio</span>
            <span className="text-[11px] text-[#6B7280]">48 members</span>
          </span>
        </div>
        {ADMIN_NAV.map((item) => (
          <span
            key={item.label}
            className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] ${item.label === "Policies" ? "bg-[#E7EAEE] font-medium text-[var(--lp-ink)]" : "text-[#374151]"}`}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </span>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col px-5 py-6 md:px-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Policies</h3>
          <span className="text-xs text-[#6B7280]">Applies to desktop, web and every MCP client</span>
        </div>
        <ul className="mt-4 flex flex-col">
          {POLICIES.map((policy) => (
            <li key={policy.label} className="flex min-h-[52px] items-center gap-4 border-b border-[#F0F1F3]">
              <span className="flex-1 text-[13px] text-[#111827]">{policy.label}</span>
              {policy.value}
            </li>
          ))}
        </ul>
        <span className="mt-4 flex items-center gap-2.5 text-xs text-[#4B5563]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-status-dot)]" aria-hidden="true" />
          Synced to 48 members 2 min ago
        </span>
      </div>
    </div>
  );
}
