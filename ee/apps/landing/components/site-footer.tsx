import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { OpenCodeLogo } from "./opencode-logo";

export function SiteFooter({ tone = "light" }: { tone?: "light" | "dark" } = {}) {
  const dark = tone === "dark";
  const strong = dark ? "text-gray-200" : "text-gray-800";
  const link = dark ? "whitespace-nowrap transition-colors hover:text-white" : "whitespace-nowrap transition-colors hover:text-gray-800";
  return (
    <footer className={`pt-10 text-sm ${dark ? "text-gray-400" : "text-gray-500"}`} data-tone={tone}>
      <div className="flex flex-col items-start justify-between gap-6 border-t border-[var(--lp-border)] pt-10 md:flex-row md:items-center">
        <div className="flex flex-col gap-2">
          <div className={`font-medium ${strong}`}>Powered by</div>
          <a
            href="https://opencode.ai"
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-3 ${dark ? "text-gray-400 hover:text-white" : "text-gray-500 hover:text-gray-800"} transition-colors`}
          >
            <OpenCodeLogo className={`h-3 w-auto ${dark ? "brightness-0 invert" : ""}`} />
          </a>
          <Link
            href="/trust"
            aria-label="SOC 2 Type I — view Trust Center"
            className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--lp-border)] px-2.5 py-1 text-[11px] font-medium transition-colors ${dark ? "text-gray-300 hover:border-white/30 hover:text-white" : "text-gray-600 hover:border-gray-400 hover:text-gray-800"}`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            SOC 2 Type I
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 md:gap-x-8">
          <Link href="/docs" target="_blank" className={link}>
            Docs
          </Link>
          <Link href="/pricing" className={link}>
            Pricing
          </Link>
          <Link href="/roadmap" className={link}>
            Roadmap
          </Link>
          <Link href="/download" className={link}>
            Desktop
          </Link>
          <Link href="/coworker" className={link}>
            Coworker
          </Link>
          <a
            href="https://app.openworklabs.com"
            target="_blank"
            rel="noreferrer"
            className={link}
          >
            Cloud
          </a>
          <Link href="/dashboard" className={link}>
            Dashboard
          </Link>
          <Link href="/enterprise" className={link}>
            Enterprise
          </Link>
          <Link href="/contact" className={link}>
            Contact
          </Link>
          <Link href="/trust" className={link}>
            Trust Center
          </Link>
          <Link href="/privacy" className={link}>
            Privacy
          </Link>
          <Link href="/terms" className={link}>
            Terms
          </Link>
          <div className="whitespace-nowrap">© 2026 Different AI</div>
        </div>
      </div>
    </footer>
  );
}
