"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";

import { LandingAppDemoPanel } from "./landing-app-demo-panel";
import {
  defaultLandingDemoFlowId,
  landingDemoFlows
} from "./landing-demo-flows";
import { LandingFaq } from "./landing-faq";
import { LandingHeroPrompt } from "./landing-hero-prompt";
import { LpCta } from "./lp-cta";
import { LpGatewayEndpoint } from "./lp-gateway-endpoint";
import { LpHeroBackground } from "./lp-hero-background";
import { LpParityTable } from "./lp-parity-table";
import { LP_PRODUCTS } from "./lp-products";
import { LpSectionHeader } from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { SocTypeIIBadge } from "./soc-type-ii-badge";
import { HeroDownloadButton } from "./hero-download-button";

type Props = {
  stars: string;
  downloadHref: string;
  windowsDownloadHref: string;
  linuxDownloadHref: string;
  callHref: string;
  isMobileVisitor: boolean;
};

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";
const GATEWAY_URL = "https://api.openworklabs.com/mcp/agent";

// Four product cells: stacked on phones, 2x2 on tablets, one row on desktop.
// Dividers are hairlines between cells only, never an outer box (DESIGN.md S1).
function productCellClass(index: number) {
  const classes = ["border-[var(--lp-border)]"];
  if (index > 0) classes.push("border-t");
  if (index === 1) classes.push("sm:border-t-0");
  if (index % 2 === 1) classes.push("sm:border-l");
  if (index > 0) classes.push("lg:border-t-0 lg:border-l");
  return classes.join(" ");
}

export function LandingHome(props: Props) {
  const [activeDemoId, setActiveDemoId] = useState(defaultLandingDemoFlowId);
  const activeDemo = useMemo(
    () => landingDemoFlows.find((flow) => flow.id === activeDemoId) ?? landingDemoFlows[0],
    [activeDemoId]
  );
  const primaryHref = props.isMobileVisitor ? CLOUD_SIGNUP_URL : "/download";
  const primaryLabel = props.isMobileVisitor ? "Open in browser" : "Download OpenWork";

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <LpHeroBackground />

      <div className="relative z-10">
        <SiteNav
          stars={props.stars}
          callUrl={props.callHref}
          mobilePrimaryHref={CLOUD_SIGNUP_URL}
          mobilePrimaryLabel="Open in browser"
          active="home"
        />

        <div
          aria-hidden="true"
          className="font-pixel mx-auto flex w-full max-w-[1176px] items-baseline justify-between px-6 pb-10 pt-6 text-[clamp(3rem,calc(21vw_-_11px),13.5rem)] leading-none tracking-[-0.06em] sm:pb-12 sm:pt-8 lg:pb-16"
        >
          {Array.from("Open").map((letter, index) => (
            <span key={`open-${index}`}>{letter}</span>
          ))}
          {Array.from("Work").map((letter, index) => (
            <span key={`work-${index}`} className="lp-wordmark-sans">
              {letter}
            </span>
          ))}
        </div>

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section
            aria-labelledby="sovereign-hero-heading"
            className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)] lg:gap-12"
          >
            <div className="relative min-w-0 lg:pt-2">
              <div className="relative">
              <p className="mb-5 text-[13px] leading-relaxed text-[var(--lp-muted)]">
                Sovereign AI for knowledge workers
              </p>
              <h1
                id="sovereign-hero-heading"
                className="text-[clamp(2.5rem,4.4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]"
              >
                <span className="block">Your AI workspace.</span>{" "}
                <span className="block">Without vendor lock-in.</span>
              </h1>
              <p className="mt-6 max-w-xl text-[17px] leading-[1.6] text-[var(--lp-body)] lg:text-lg">
                The open-source alternative to Claude Cowork and Codex. Run any
                model on any infrastructure.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                {props.isMobileVisitor ? (
                  <a
                    href={CLOUD_SIGNUP_URL}
                    className="doc-button inline-flex items-center gap-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in browser <ArrowRight size={18} aria-hidden="true" />
                  </a>
                ) : (
                  <HeroDownloadButton />
                )}
                <a href="/enterprise" className="lp-btn lp-btn--secondary">
                  Explore enterprise
                </a>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs text-[var(--lp-muted)]">
                <span>Free desktop app</span>
                <span aria-hidden="true">·</span>
                <a href="/download" className="underline-offset-4 hover:underline">macOS</a>
                <span aria-hidden="true">·</span>
                <a href={props.windowsDownloadHref} className="underline-offset-4 hover:underline">Windows</a>
                <span aria-hidden="true">·</span>
                <a href={props.linuxDownloadHref} className="underline-offset-4 hover:underline">Linux</a>
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-4">
                <div className="flex items-center gap-2 text-xs text-[var(--lp-muted)]">
                <span>Backed by</span>
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] text-white">Y</span>
                <span className="font-medium">Combinator</span>
                </div>
                <a
                  href="/trust"
                  aria-label="SOC 2 Type II audit complete. View Trust Center"
                  className="flex shrink-0 items-center gap-3 border-l border-[var(--lp-border)] pl-4 transition-opacity hover:opacity-80"
                >
                  <SocTypeIIBadge className="h-14 w-14" />
                  <span className="flex flex-col leading-tight" aria-hidden="true">
                    <span className="text-[13px] font-medium text-[var(--lp-ink)]">SOC 2 Type II</span>
                    <span className="text-xs text-[var(--lp-muted)]">Audit complete</span>
                  </span>
                </a>
              </div>
              </div>
            </div>
            {props.isMobileVisitor ? null : (
              <div className="flex min-w-0 self-stretch lg:items-end lg:justify-end">
                <LandingHeroPrompt className="w-full lg:max-w-[440px]" />
              </div>
            )}
          </section>

          <section aria-labelledby="products-heading" className="mt-16 lg:mt-24">
            <h2 id="products-heading" className="mb-4 text-[13px] font-normal text-[var(--lp-muted)]">
              Products
            </h2>
            <ul className="grid border-y border-[var(--lp-border)] sm:grid-cols-2 lg:grid-cols-4">
              {LP_PRODUCTS.map((product, index) => (
                <li key={product.key} className={productCellClass(index)}>
                  <a
                    href={product.href}
                    className={`group flex h-full flex-col gap-6 py-6 sm:py-7 lg:gap-10 ${index % 2 === 0 ? "sm:pr-6" : "sm:px-6"} ${index === 2 ? "lg:px-6" : ""}`}
                  >
                    <product.icon
                      className="h-5 w-5 text-[var(--lp-ink)]"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    <span className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 text-[20px] font-medium tracking-[-0.02em] text-[var(--lp-ink)]">
                        {product.name}
                        <ArrowRight
                          size={16}
                          aria-hidden="true"
                          className="-translate-x-1 opacity-0 transition duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none"
                        />
                      </span>
                      <span className="text-[14px] leading-[21px] text-[var(--lp-body)]">
                        {product.line}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-20 lg:mt-[120px]" id="comparison">
            <LpSectionHeader
              label="OpenWork vs Claude Cowork"
              heading="Feature parity. Zero lock-in."
              right={
                <a href="/docs/start-here/migrate-from-claude-cowork" className="lp-pill-secondary lp-pill-sm !hidden md:!inline-flex">
                  See the migration guide
                </a>
              }
            />
            <a
              href="/docs/start-here/migrate-from-claude-cowork"
              className="lp-pill-secondary lp-pill-sm mt-6 md:!hidden"
            >
              See the migration guide
            </a>
            <div className="mt-10">
              <LpParityTable />
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader
              label="MCP Gateway"
              heading="Set up your MCPs once. Your whole team has them."
              headingLines={["Set up your MCPs once.", "Your whole team has them."]}
              right={
                <a href="/connect" className="lp-pill-secondary lp-pill-sm !hidden md:!inline-flex">
                  Explore MCP Gateway
                </a>
              }
            />
            <a href="/connect" className="lp-pill-secondary lp-pill-sm mt-6 md:!hidden">
              Explore MCP Gateway
            </a>
            <div className="mt-10">
              <LpGatewayEndpoint url={GATEWAY_URL} />
            </div>
          </section>

          <section
            id="product"
            className="mt-[120px] scroll-mt-24"
            aria-label="OpenWork product demo"
          >
            <div className="landing-shell overflow-hidden rounded-2xl">
              <div className="relative flex h-10 items-center border-b border-white/50 bg-gradient-to-b from-white/90 to-white/60 px-4">
                <div className="flex gap-1.5" aria-hidden="true">
                  <div className="h-2.5 w-2.5 rounded-full border border-[#e0443e]/20 bg-[#ff5f56]/90" />
                  <div className="h-2.5 w-2.5 rounded-full border border-[#dea123]/20 bg-[#ffbd2e]/90" />
                  <div className="h-2.5 w-2.5 rounded-full border border-[#1aab29]/20 bg-[#27c93f]/90" />
                </div>
                <span className="absolute left-1/2 -translate-x-1/2 text-xs font-medium text-[var(--lp-muted)]">OpenWork</span>
              </div>
              <div className="p-3">
                <LandingAppDemoPanel
                  flows={landingDemoFlows}
                  activeFlowId={activeDemo.id}
                  onSelectFlow={setActiveDemoId}
                />
              </div>
              <div className="flex flex-wrap gap-1 border-t border-[var(--lp-border)] px-3 py-3" role="group" aria-label="Example tasks">
                {landingDemoFlows.map((flow) => {
                  const isActive = flow.id === activeDemo.id;
                  return (
                    <button
                      key={flow.id}
                      type="button"
                      onClick={() => setActiveDemoId(flow.id)}
                      aria-pressed={isActive}
                      className={`relative cursor-pointer rounded-full px-3 py-2 text-xs transition-colors ${isActive ? "text-[var(--lp-ink)]" : "text-[var(--lp-muted)] hover:text-[var(--lp-ink)]"}`}
                    >
                      {isActive ? (
                        <motion.div
                          layoutId="active-pill"
                          className="absolute inset-0 rounded-full border border-[var(--lp-border)] bg-white shadow-sm"
                          transition={{ type: "spring", stiffness: 400, damping: 30 }}
                        />
                      ) : null}
                      <span className="relative z-10">{flow.categoryLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-[var(--lp-muted)]" aria-live="polite">
              {activeDemo.description}
            </p>
          </section>

          <div className="mt-[120px] [&_h2]:!text-[36px] [&_h2]:!leading-[42px]">
            <LandingFaq />
          </div>

          <div className="mt-[120px]">
            <LpCta
              heading="Give your whole team an agent."
              sub="Free on desktop. Central management in Cloud. Private instances for enterprise."
              primary={{ label: primaryLabel, href: primaryHref }}
              secondary={{ label: "Talk to sales", href: props.callHref }}
              trust="Free & open source · No account required to start"
            />
          </div>

          <div className="mt-16">
            <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}
