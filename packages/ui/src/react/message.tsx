import type { HTMLProps } from "react";
import { twMerge } from "tailwind-merge";

export type MessageProps = HTMLProps<HTMLDivElement>;
/** Conversation layout shared by the desktop and cloud chat surfaces. */
export function Message({ children, className, ...props }: MessageProps) {
  return (
    <div className={twMerge("flex gap-3", className)} {...props}>
      {children}
    </div>
  );
}
export type MessageActionsProps = HTMLProps<HTMLDivElement>;
export function MessageActions({
  children,
  className,
  ...props
}: MessageActionsProps) {
  return (
    <div
      className={twMerge(
        "text-muted-foreground flex items-center gap-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
