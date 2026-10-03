import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";

const tones = {
  info: { box: "border-info/25 bg-info/8", icon: <Info className="size-4 text-info" /> },
  warn: { box: "border-warn/25 bg-warn/8", icon: <TriangleAlert className="size-4 text-warn" /> },
  danger: {
    box: "border-danger/25 bg-danger/8",
    icon: <CircleAlert className="size-4 text-danger" />,
  },
};

export function Banner({
  tone = "info",
  title,
  children,
  actions,
  onDismiss,
  className,
}: {
  tone?: keyof typeof tones;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-3 rounded-xl border px-4 py-3", tones[tone].box, className)}>
      <div className="mt-0.5 shrink-0">{tones[tone].icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children && <div className="mt-1 text-xs text-muted">{children}</div>}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-0.5 h-6 w-6 shrink-0 rounded-md text-muted hover:bg-surface-3 hover:text-fg"
        >
          <X className="mx-auto size-3.5" />
        </button>
      )}
    </div>
  );
}
