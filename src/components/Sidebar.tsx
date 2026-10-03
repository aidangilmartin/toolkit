import { Gamepad2, History, Package, Settings } from "lucide-react";
import type { ReactNode } from "react";

import { timeAgo } from "../lib/format";
import { cn } from "../lib/cn";
import { useApp, type View } from "../store/app";
import { ColorDot } from "./ui/misc";

const items: { view: View; label: string; icon: ReactNode }[] = [
  { view: { name: "home" }, label: "Play", icon: <Gamepad2 /> },
  { view: { name: "packs" }, label: "Packs", icon: <Package /> },
  { view: { name: "backups" }, label: "Backups", icon: <History /> },
  { view: { name: "settings" }, label: "Settings", icon: <Settings /> },
];

export function Sidebar() {
  const view = useApp((s) => s.view);
  const navigate = useApp((s) => s.navigate);
  const running = useApp((s) => s.running);
  const status = useApp((s) => s.status);
  const profiles = useApp((s) => s.profiles);
  const active = profiles.find((p) => p.id === status?.activeProfileId);
  const current = view.name === "profile" ? "home" : view.name;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface/60">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
        <img src="/icon.svg" alt="" className="size-8" />
        <div>
          <p className="text-[15px] leading-tight font-semibold">Loadout</p>
          <p className="text-[11px] text-subtle">GTA V · FiveM profiles</p>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {items.map((item) => (
          <button
            key={item.label}
            onClick={() => navigate(item.view)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors [&>svg]:size-4",
              current === item.view.name
                ? "bg-surface-3 text-fg"
                : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mt-auto space-y-3 p-4">
        <div className="rounded-xl border border-line bg-surface-2 p-3">
          <p className="text-[11px] font-medium tracking-wider text-subtle uppercase">Active</p>
          {active ? (
            <div className="mt-1.5">
              <div className="flex items-center gap-2">
                <ColorDot color={active.color} />
                <span className="truncate text-sm font-medium">{active.name}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-subtle">Applied {timeAgo(status?.appliedAt)}</p>
            </div>
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              {status?.deployedFiles.length === 0 ? "Vanilla" : "Custom"}
            </p>
          )}
        </div>
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs",
            running.length
              ? "border-warn/30 bg-warn/10 text-warn"
              : "border-line bg-surface-2 text-muted",
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              running.length ? "animate-pulse bg-warn" : "bg-accent",
            )}
          />
          {running.length ? "FiveM is running" : "Game closed · ready"}
        </div>
      </div>
    </aside>
  );
}
