import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

export type ComposerActionProps = ComponentProps<"button"> & {
  mode?: "send" | "stop" | "busy";
};
/** One accessible send/stop slot. Callers keep their own submission and cancellation handlers. */
export function ComposerAction({
  mode = "send",
  children,
  className,
  type = "button",
  ...props
}: ComposerActionProps) {
  return (
    <button
      type={type}
      className={twMerge(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
        className,
      )}
      aria-busy={mode === "busy" || undefined}
      {...props}
    >
      {children ??
        (mode === "stop" ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="8" height="8" rx="1" />
          </svg>
        ) : (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        ))}
    </button>
  );
}
