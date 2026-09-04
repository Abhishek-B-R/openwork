import type { Metadata } from "next";
import "./coworker.css";
import { CoworkerAvatar, CoworkerMark } from "../../components/coworker-brand";
import { CoworkerVignette, TEAM } from "../../components/coworker-vignette";
import { CoworkerAction, CoworkerAnnouncementView } from "../../components/coworker-announcement-actions";
import { StructuredData } from "../../components/structured-data";
import { BENEFITS, COWORKER, FAQ, GET_STARTED, HERO, MODELS, NOTIFY, POWERED_BY, STEPS } from "../../lib/coworker-content";

const SITE_URL = "https://openworklabs.com";
const NAV = [{ href: "#how", label: "How it works" }, { href: "#models", label: "Models" }];
const SHARED_LINKS = [{ href: "/docs", label: "Docs" }, { href: "/pricing", label: "Team pricing" }, { href: "/enterprise", label: "Enterprise" }, { href: "/", label: "OpenWork" }];

export const metadata: Metadata = {
  title: "Open Coworker — A coworker who remembers",
  description: HERO.lead,
  alternates: { canonical: "/coworker" },
  openGraph: {
    title: "Open Coworker — A coworker who remembers",
    description: HERO.lead,
    url: SITE_URL + "/coworker",
    siteName: "Open Coworker",
    images: ["/coworker/og.png"],
  },
  twitter: { card: "summary_large_image", images: ["/coworker/og.png"] },
};

function PoweredBy() {
  return <a href="/" className="inline-flex items-center gap-2 text-xs text-[var(--cw-ink-500)]" data-testid="coworker-powered-by">
    {/* eslint-disable-next-line @next/next/no-img-element -- a small brand SVG */}
    <img src="/openwork-mark.svg" alt="" aria-hidden="true" width={16} height={13} />
    <span>{POWERED_BY}</span>
  </a>;
}

export default function CoworkerPage() {
  return (
    <div className="cw relative min-h-screen overflow-x-hidden" data-testid="coworker-page">
      <CoworkerAnnouncementView />
      <StructuredData data={{
        "@context": "https://schema.org", "@type": "SoftwareApplication",
        name: COWORKER.name, description: HERO.lead, applicationCategory: "BusinessApplication",
        operatingSystem: "macOS", url: SITE_URL + COWORKER.path,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        license: "https://opensource.org/licenses/MIT", codeRepository: COWORKER.repository,
        publisher: { "@type": "Organization", name: "OpenWork", url: SITE_URL },
      }} />
      <div className="cw-backdrop" aria-hidden="true" />
      <div className="relative z-10">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-white focus:p-3">Skip to content</a>
        <header className="cw-nav sticky top-0 z-40">
          <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-3 px-5 md:px-8">
            <a href="#top" className="flex shrink-0 items-center gap-2.5 font-bold tracking-tight">
              <CoworkerMark size={28} label="Open Coworker" />
              <span className="text-sm sm:text-base">{COWORKER.name}</span>
            </a>
            <nav aria-label="Primary" className="flex items-center gap-6">
              {NAV.map((link) => <a key={link.href} href={link.href} className="hidden text-sm text-[var(--cw-ink-500)] hover:text-[var(--cw-ink)] sm:block">{link.label}</a>)}
              <CoworkerAction href={HERO.primary.href} action="early_access" placement="nav" className="cw-btn cw-btn--primary cw-btn--sm">{HERO.primary.label}</CoworkerAction>
            </nav>
          </div>
        </header>

        <main id="main-content">
          <section id="top" className="cw-accent-blue px-5 pb-6 pt-16 md:px-8 md:pt-24">
            <div className="mx-auto max-w-[1040px]">
              <p className="cw-eyebrow">{HERO.eyebrow}</p>
              <h1 className="cw-display mt-6 max-w-[900px] text-[48px] sm:text-[72px] lg:text-[88px]">A coworker<br />who <span className="cw-mark">remembers.</span></h1>
              <p className="mt-7 max-w-[650px] text-lg leading-relaxed text-[var(--cw-ink-700)] md:text-xl">{HERO.lead}</p>
              <p className="mt-4 max-w-xl text-sm leading-6 text-[var(--cw-ink-500)]">{HERO.aside}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <CoworkerAction href={HERO.primary.href} action="early_access" placement="hero" className="cw-btn cw-btn--primary">{HERO.primary.label}<span aria-hidden="true">↗</span></CoworkerAction>
                <CoworkerAction href={HERO.secondary.href} action="how_it_works" placement="hero" className="cw-btn cw-btn--ghost">{HERO.secondary.label}<span aria-hidden="true">↓</span></CoworkerAction>
              </div>
              <p className="mt-4 text-xs leading-5 text-[var(--cw-ink-500)]">Early access for macOS. Signed downloads are in preparation.</p>
              <div className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--cw-rule)] pt-5 text-xs text-[var(--cw-ink-500)]">
                {HERO.strip.map((phrase) => <span key={phrase}>{phrase}</span>)}
              </div>
            </div>
          </section>

          <section id="how" className="scroll-mt-24 px-5 py-16 md:px-8 md:py-20">
            <div className="mx-auto max-w-[1040px]">
              <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div><p className="cw-eyebrow">From a question to a useful result</p><h2 className="cw-display mt-4 text-3xl md:text-[42px]">Give it something real.</h2></div>
                <p className="max-w-xs text-sm leading-6 text-[var(--cw-ink-500)]">A brief to help you decide.<br />Context to build on next time.</p>
              </div>
              <figure aria-label="An illustrative Open Coworker conversation">
                <CoworkerVignette />
                <figcaption className="mt-4 text-center text-xs text-[var(--cw-ink-500)]">Illustrative conversation. Results depend on your request, connected tools, and chosen model.</figcaption>
              </figure>
              <ol className="mt-12 grid gap-8 md:grid-cols-3">
                {STEPS.map((step, index) => <li key={step.title} className="border-t border-[var(--cw-rule)] pt-5">
                  <span className="cw-eyebrow">0{index + 1}</span>
                  <h3 className="mt-3 text-lg font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--cw-ink-700)]">{step.text}</p>
                </li>)}
              </ol>
            </div>
          </section>

          <section className="px-5 pb-16 md:px-8 md:pb-24" aria-label="What your coworker helps with">
            <div className="mx-auto grid max-w-[1040px] gap-5 md:grid-cols-3">
              {BENEFITS.map((benefit, index) => {
                const avatar = TEAM[index]!;
                return <article key={benefit.title} className="cw-bubble flex flex-col p-6">
                  <div className="flex items-center gap-3"><CoworkerAvatar name={benefit.name} color={avatar.color} glasses={avatar.glasses} size={44} /><p className="text-sm font-semibold">{benefit.name}<span className="mt-0.5 block text-xs font-normal text-[var(--cw-ink-500)]">{benefit.role}</span></p></div>
                  <h2 className="mt-6 text-xl font-semibold leading-tight tracking-tight">{benefit.title}</h2>
                  <p className="mt-3 text-sm leading-6 text-[var(--cw-ink-700)]">{benefit.text}</p>
                  <p className="mt-auto pt-6 text-sm leading-6 text-[var(--cw-ink-500)]">“{benefit.example}”</p>
                </article>;
              })}
            </div>
          </section>

          <section id="models" className="cw-ink-band scroll-mt-16 px-5 py-16 md:px-8 md:py-20" data-testid="coworker-models">
            <div className="mx-auto grid max-w-[1040px] gap-10 md:grid-cols-[3fr_2fr] md:items-center">
              <div>
                <p className="cw-eyebrow !text-white/60">OpenWork Models</p>
                <h2 className="mt-4 max-w-lg text-[34px] font-semibold leading-[1.08] tracking-[-0.04em] md:text-[44px]">{MODELS.title}</h2>
                <p className="mt-5 max-w-lg text-base leading-7 text-white/75">{MODELS.lead.text}</p>
              </div>
              <div className="rounded-2xl border border-white/20 bg-white/[0.04] p-6 md:p-7">
                <p className="text-base leading-7 text-white/85">{MODELS.detail}</p>
                <CoworkerAction href={MODELS.cta.href} action="models" placement="models" className="cw-btn mt-6 w-full !bg-[var(--cw-paper)] !text-[var(--cw-ink)] hover:!bg-white">{MODELS.cta.label}<span aria-hidden="true">↗</span></CoworkerAction>
                <CoworkerAction href={MODELS.member.href} action="member_sign_in" placement="models" className="mt-4 block text-center text-sm text-white/75 underline underline-offset-4 hover:text-white">{MODELS.member.label}</CoworkerAction>
                <p className="mt-5 border-t border-white/15 pt-4 text-xs leading-5 text-white/60">{MODELS.note}</p>
              </div>
            </div>
          </section>

          <section className="px-5 py-16 md:px-8 md:py-20" aria-label="Questions about Open Coworker">
            <div className="mx-auto max-w-[720px]">
              <h2 className="cw-display mb-8 text-3xl">A few things to know.</h2>
              <div className="divide-y divide-[var(--cw-rule)] border-y border-[var(--cw-rule)]">
                {FAQ.map((item, index) => <details key={item.question} className="group py-5">
                  <summary data-testid={`coworker-question-${index}`} className="cursor-pointer text-base font-medium">{item.question}</summary>
                  <p className="mt-3 pr-4 text-sm leading-7 text-[var(--cw-ink-700)]">{item.text}</p>
                </details>)}
              </div>
            </div>
          </section>

          <section id="get-started" className="cw-accent-mint scroll-mt-24 px-5 pb-20 text-center md:px-8 md:pb-24">
            <div className="mx-auto max-w-[720px]">
              <CoworkerMark size={52} label="Open Coworker" />
              <h2 className="cw-display mt-6 text-[38px] md:text-[52px]">{GET_STARTED.title}</h2>
              <p className="mx-auto mt-5 max-w-lg text-base leading-7 text-[var(--cw-ink-700)]">{GET_STARTED.lead}</p>
              <CoworkerAction href={NOTIFY.email.href} action="email_early_access" placement="footer" className="cw-btn cw-btn--primary mt-7">{NOTIFY.email.label}<span aria-hidden="true">↗</span></CoworkerAction>
              <p className="mt-3 text-xs text-[var(--cw-ink-500)]">Opens your email app · {COWORKER.contactEmail}</p>
              <p className="mt-5 text-xs text-[var(--cw-ink-500)]">{GET_STARTED.status}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-5 text-sm">
                <CoworkerAction href={COWORKER.app} action="source" placement="footer" className="underline decoration-[var(--cw-rule)] underline-offset-4">Build from source</CoworkerAction>
                <CoworkerAction href={NOTIFY.releases.href} action="releases" placement="footer" className="underline decoration-[var(--cw-rule)] underline-offset-4">{NOTIFY.releases.label}</CoworkerAction>
              </div>
            </div>
          </section>
        </main>

        <footer className="border-t border-[var(--cw-rule)] px-5 py-8 md:px-8">
          <div className="mx-auto flex max-w-[1040px] flex-col justify-between gap-6 md:flex-row md:items-center">
            <PoweredBy />
            <nav aria-label="Footer" className="flex flex-wrap gap-5 text-xs text-[var(--cw-ink-500)]">
              {SHARED_LINKS.map((link) => <a key={link.href} href={link.href} className="hover:text-[var(--cw-ink)]">{link.label}</a>)}
              <a href={COWORKER.repository}>GitHub</a>
            </nav>
            <p className="text-xs text-[var(--cw-ink-500)]">© {new Date().getFullYear()} Different AI</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
