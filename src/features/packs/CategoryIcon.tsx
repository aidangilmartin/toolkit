import { Box, FolderCog, Palette, Volume2, Wrench } from "lucide-react";

import type { PackCategory } from "../../api/types";
import { cn } from "../../lib/cn";

const icons = {
  soundPack: { Icon: Volume2, className: "text-accent bg-accent/10" },
  citizen: { Icon: FolderCog, className: "text-info bg-info/10" },
  reshade: { Icon: Palette, className: "text-[#f472b6] bg-[#f472b6]/10" },
  mods: { Icon: Box, className: "text-warn bg-warn/10" },
  other: { Icon: Wrench, className: "text-muted bg-surface-3" },
} satisfies Record<PackCategory, unknown>;

export function CategoryIcon({
  category,
  size = "md",
}: {
  category: PackCategory;
  size?: "md" | "lg";
}) {
  const { Icon, className } = icons[category];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        size === "lg" ? "size-10" : "size-8",
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}
