import type { ComponentProps } from "react";

export function Empty({ className = "", ...props }: ComponentProps<"div">) {
  return <div {...props} className={`flex flex-col items-start gap-3 py-6 ${className}`} />;
}

export function EmptyHeader(props: ComponentProps<"div">) {
  return <div {...props} className="flex flex-col gap-2" />;
}

export function EmptyTitle(props: ComponentProps<"p">) {
  return <p {...props} className="text-sm font-medium text-[var(--dls-text-primary)]" />;
}

export function EmptyContent(props: ComponentProps<"div">) {
  return <div {...props} className="flex items-center gap-2" />;
}
