import { Server } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/cn";

/** A server's logo, or a tile in the profile's colour when there isn't one (or it won't load). */
export function ServerLogo({
  icon,
  color,
  className,
}: {
  icon: string | null;
  color: string;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (icon && failed !== icon) {
    return (
      <img
        src={icon}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(icon)}
        className={cn("size-10 shrink-0 rounded-xl bg-surface-3 object-cover", className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl border border-line",
        className,
      )}
      style={{ background: `linear-gradient(135deg, ${color}40, ${color}10)`, color }}
    >
      <Server className="size-[45%]" />
    </div>
  );
}
