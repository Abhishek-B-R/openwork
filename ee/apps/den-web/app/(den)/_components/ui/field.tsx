import type { ComponentProps } from "react";

export function FieldGroup({ className = "", ...props }: ComponentProps<"div">) {
  return <div {...props} className={`flex flex-col gap-4 ${className}`} />;
}

export function Field({ className = "", ...props }: ComponentProps<"div">) {
  return <div role="group" {...props} className={`flex flex-col gap-2 ${className}`} />;
}

export function FieldLabel({ className = "", ...props }: ComponentProps<"label">) {
  return <label {...props} className={`text-sm font-medium text-[var(--dls-text-primary)] ${className}`} />;
}

export function FieldError({ children, ...props }: ComponentProps<"p">) {
  if (!children) return null;
  return <p {...props} role="alert" className="text-sm text-[var(--ow-danger)]">{children}</p>;
}
