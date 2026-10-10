import { CircleCheck, ImagePlus, Search, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Profile, ServerInfo } from "../../api/types";
import { ServerLogo } from "../../components/ServerLogo";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/form";

export type ServerFields = Pick<Profile, "serverAddress" | "serverName" | "serverIcon">;

/**
 * The server a profile joins after applying: the address, plus the name and logo
 * looked up from the server (or picked by hand when it can't be reached).
 */
export function ServerSection({
  value,
  color,
  onChange,
  onFound,
  onBusy,
  autoFocus,
}: {
  value: ServerFields;
  color: string;
  onChange: (patch: Partial<ServerFields>) => void;
  /** Called after a successful lookup, e.g. to name a new profile after the server. */
  onFound?: (info: ServerInfo) => void;
  onBusy?: (busy: boolean) => void;
  autoFocus?: boolean;
}) {
  const address = value.serverAddress ?? "";
  const [lookedUp, setLookedUp] = useState(address);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ServerInfo | null>(null);
  // The address as typed right now, to drop answers for an address that was changed meanwhile.
  const latest = useRef(address);
  useEffect(() => {
    latest.current = address;
  }, [address]);

  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  const lookup = async () => {
    const wanted = address.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setError(null);
    setFound(null);
    setLookedUp(wanted);
    try {
      const info = await api.lookupServer(wanted);
      if (latest.current.trim() !== wanted) return;
      onChange({
        serverAddress: info.address,
        serverName: info.name ?? value.serverName,
        serverIcon: info.icon ?? value.serverIcon,
      });
      setLookedUp(info.address);
      setFound(info);
      onFound?.(info);
    } catch (err) {
      if (latest.current.trim() === wanted) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseLogo = async () => {
    try {
      const path = await api.pickImage();
      if (path) onChange({ serverIcon: await api.readLogoFile(path) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const clear = () => {
    onChange({ serverAddress: null, serverName: null, serverIcon: null });
    setLookedUp("");
    setFound(null);
    setError(null);
  };

  return (
    <div className="flex gap-4">
      <ServerLogo icon={value.serverIcon} color={color} className="size-16 rounded-2xl" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              autoFocus={autoFocus}
              value={address}
              onChange={(e) => {
                onChange({ serverAddress: e.target.value });
                setError(null);
              }}
              onBlur={() => {
                if (address.trim() && address.trim() !== lookedUp) void lookup();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void lookup();
                }
              }}
              placeholder="Server IP:port or cfx.re/join code"
              aria-label="Server address"
              className="pr-8"
            />
            {address && (
              <button
                type="button"
                // Keep focus in the input, so leaving it doesn't start a lookup first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={clear}
                aria-label="Remove server"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Button
            icon={<Search className="size-4" />}
            loading={busy}
            disabled={!address.trim()}
            onClick={() => void lookup()}
          >
            Look up
          </Button>
        </div>

        {busy ? (
          <p className="text-xs text-muted">Looking up the server…</p>
        ) : error ? (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>{error} You can still save it, and pick a logo yourself.</span>
          </p>
        ) : found ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <CircleCheck className="size-3.5 shrink-0 text-accent" />
            <span className="truncate">
              Found {found.name ?? found.address}
              {found.players !== null &&
                ` · ${found.players}${found.maxPlayers ? `/${found.maxPlayers}` : ""} players online`}
              {!found.icon && " · it has no logo"}
            </span>
          </p>
        ) : (
          !address && (
            <p className="text-xs text-muted">
              Optional. Play applies the profile, then joins this server.
            </p>
          )
        )}

        {address && (
          <div className="flex flex-wrap gap-2">
            <Input
              value={value.serverName ?? ""}
              onChange={(e) => onChange({ serverName: e.target.value || null })}
              placeholder="Server name"
              aria-label="Server name"
              maxLength={80}
              className="h-8 min-w-40 flex-1 text-xs"
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<ImagePlus className="size-3.5" />}
              onClick={() => void chooseLogo()}
            >
              {value.serverIcon ? "Change logo" : "Choose logo"}
            </Button>
            {value.serverIcon && (
              <Button size="sm" variant="ghost" onClick={() => onChange({ serverIcon: null })}>
                Remove logo
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
