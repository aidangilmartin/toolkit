import {
  CircleCheck,
  Globe,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Profile, ServerInfo, ServerListing, ServerSearch } from "../../api/types";
import { ServerLogo } from "../../components/ServerLogo";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/form";
import { cn } from "../../lib/cn";

export type ServerFields = Pick<Profile, "serverAddress" | "serverName" | "serverIcon">;

/** IP:port, a hostname or a cfx.re link: joinable without searching the list. */
const ADDRESS =
  /^(fivem:\/\/connect\/|https?:\/\/)?(cfx\.re\/join\/[a-z0-9]{5,8}|localhost(:\d{1,5})?|[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?)\/?$/i;
/** A bare word that could be a cfx.re join code. */
const JOIN_CODE = /^[a-z0-9]{5,8}$/i;

const number = new Intl.NumberFormat();

/**
 * The server a profile joins after applying. Search the FiveM server list (or
 * paste an address), pick a server, and its name and logo are filled in.
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
  /** Called once a server is picked or looked up, e.g. to name a new profile after it. */
  onFound?: (info: ServerInfo) => void;
  onBusy?: (busy: boolean) => void;
  autoFocus?: boolean;
}) {
  const address = value.serverAddress ?? "";
  const [searching, setSearching] = useState(!address);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Pick<ServerInfo, "players" | "maxPlayers"> | null>(null);
  // The listing's logo, shown while the real one is being fetched.
  const [preview, setPreview] = useState<string | null>(null);
  // Answers for a server that's no longer the chosen one are dropped.
  const request = useRef(0);

  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  const lookup = async (
    wanted: string,
    fallbackName: string | null,
    fallbackIcon: string | null,
  ) => {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const info = await api.lookupServer(wanted);
      if (request.current !== id) return;
      onChange({
        serverAddress: info.address,
        serverName: info.name ?? fallbackName,
        serverIcon: info.icon ?? fallbackIcon,
      });
      setFound(info);
      onFound?.(info);
    } catch (err) {
      if (request.current === id) setError(errorMessage(err));
    } finally {
      if (request.current === id) {
        setBusy(false);
        setPreview(null);
      }
    }
  };

  const pick = (listing: ServerListing) => {
    const picked = `cfx.re/join/${listing.id}`;
    onChange({ serverAddress: picked, serverName: listing.name, serverIcon: null });
    setPreview(listing.iconUrl);
    setFound(listing);
    setSearching(false);
    onFound?.({ ...listing, address: picked, icon: null });
    void lookup(picked, listing.name, null);
  };

  const useAddress = (typed: string) => {
    onChange({ serverAddress: typed, serverName: null, serverIcon: null });
    setPreview(null);
    setFound(null);
    setSearching(false);
    void lookup(typed, null, null);
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
    request.current++;
    onChange({ serverAddress: null, serverName: null, serverIcon: null });
    setBusy(false);
    setError(null);
    setFound(null);
    setPreview(null);
    setSearching(true);
  };

  if (searching || !address) {
    return (
      <ServerSearchBox
        autoFocus={autoFocus}
        color={color}
        onPick={pick}
        onUseAddress={useAddress}
        onCancel={address ? () => setSearching(false) : undefined}
      />
    );
  }

  return (
    <div className="flex gap-4">
      <ServerLogo
        icon={value.serverIcon ?? preview}
        color={color}
        className="size-16 rounded-2xl"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={value.serverName ?? ""}
              onChange={(e) => onChange({ serverName: e.target.value || null })}
              placeholder="Server name"
              aria-label="Server name"
              maxLength={80}
              className="h-8 font-medium"
            />
            <p className="mt-1 truncate text-[11px] text-subtle">
              <span className="font-mono">{address}</span>
              {found?.players != null &&
                ` · ${found.players}${found.maxPlayers ? `/${found.maxPlayers}` : ""} players online`}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Remove server" onClick={clear}>
            <X className="size-4" />
          </Button>
        </div>

        {busy ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <LoaderCircle className="size-3.5 animate-spin" />
            Getting the server's logo…
          </p>
        ) : error ? (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>{error} You can still save it, and pick a logo yourself.</span>
          </p>
        ) : (
          value.serverIcon && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <CircleCheck className="size-3.5 shrink-0 text-accent" />
              Play joins this server after applying the profile.
            </p>
          )
        )}

        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={<Search className="size-3.5" />}
            onClick={() => setSearching(true)}
          >
            Change server
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className="size-3.5" />}
            disabled={busy}
            onClick={() => void lookup(address, value.serverName, value.serverIcon)}
          >
            Look up again
          </Button>
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
      </div>
    </div>
  );
}

/** The last answer from the server list, and the query it answers. */
interface Answer {
  query: string;
  search: ServerSearch | null;
  error: string | null;
}

type Row = { kind: "address"; address: string } | { kind: "server"; server: ServerListing };

/** The search field and its results, from the FiveM server list. */
function ServerSearchBox({
  autoFocus,
  color,
  onPick,
  onUseAddress,
  onCancel,
}: {
  autoFocus?: boolean;
  color: string;
  onPick: (server: ServerListing) => void;
  onUseAddress: (address: string) => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [lastSearch, setLastSearch] = useState<ServerSearch | null>(null);
  const [active, setActive] = useState(0);
  const request = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (!open) return;
    const id = ++request.current;
    const timer = window.setTimeout(
      async () => {
        try {
          const search = await api.searchServers(trimmed);
          if (request.current !== id) return;
          setAnswer({ query: trimmed, search, error: null });
          setLastSearch(search);
        } catch (err) {
          if (request.current === id) {
            setAnswer({ query: trimmed, search: null, error: errorMessage(err) });
          }
        }
      },
      trimmed ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [trimmed, open]);

  // Until the current query is answered, the previous results stay on screen.
  const pending = answer?.query !== trimmed;
  const failed = !pending && answer?.error ? answer.error : null;
  const search = failed ? null : lastSearch;
  const servers = search?.results ?? [];
  const exact = servers.some((s) => s.id.toLowerCase() === trimmed.toLowerCase());
  const rows: Row[] = [
    ...(ADDRESS.test(trimmed) ? [{ kind: "address" as const, address: trimmed }] : []),
    ...servers.map((server) => ({ kind: "server" as const, server })),
    ...(JOIN_CODE.test(trimmed) && !exact
      ? [{ kind: "address" as const, address: `cfx.re/join/${trimmed}` }]
      : []),
  ];
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  const choose = (row: Row) => {
    setOpen(false);
    if (row.kind === "server") onPick(row.server);
    else onUseAddress(row.address);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const next = Math.max(
        0,
        Math.min(rows.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)),
      );
      setActive(next);
      list.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && rows[current]) choose(rows[current]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input
            autoFocus={autoFocus}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            // Lets a surrounding dialog know Esc closes this list first.
            data-captures-escape={open ? "" : undefined}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Search FiveM servers, or paste an IP or cfx.re link"
            aria-label="Search servers"
            role="combobox"
            aria-expanded={open}
            aria-controls="server-results"
            className="pr-8 pl-9"
          />
          {open && pending && (
            <LoaderCircle className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-subtle" />
          )}
        </div>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Keep current
          </Button>
        )}
      </div>

      {open ? (
        <div
          id="server-results"
          role="listbox"
          aria-label="Servers"
          // Keep focus in the search field while clicking a result.
          onMouseDown={(e) => e.preventDefault()}
          className="mt-2 overflow-hidden rounded-xl border border-line bg-surface-2"
        >
          <div ref={list} className="max-h-72 overflow-y-auto">
            {rows.map((row, index) => (
              <button
                key={row.kind === "server" ? row.server.id : `address:${row.address}`}
                type="button"
                role="option"
                aria-selected={index === current}
                data-row={index}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                  index === current ? "bg-surface-3" : "hover:bg-surface-3/60",
                )}
              >
                {row.kind === "server" ? (
                  <ServerRow server={row.server} color={color} />
                ) : (
                  <>
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line text-muted">
                      <Globe className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        Use <span className="font-mono">{row.address}</span>
                      </p>
                      <p className="text-xs text-muted">Join by address, even if it isn't listed</p>
                    </div>
                  </>
                )}
              </button>
            ))}
          </div>
          <PanelStatus
            search={search}
            pending={pending}
            error={failed}
            query={trimmed}
            hasRows={rows.length > 0}
          />
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-muted">
          Optional. Play applies the profile, then joins this server.
        </p>
      )}
    </div>
  );
}

function ServerRow({ server, color }: { server: ServerListing; color: string }) {
  return (
    <>
      <ServerLogo icon={server.iconUrl} color={color} className="size-9 rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{server.name}</p>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted tabular-nums">
            <Users className="size-3" />
            {server.players}/{server.maxPlayers}
          </span>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <span className="min-w-0 truncate">{server.description ?? server.tags.join(" · ")}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-subtle">{server.id}</span>
        </p>
      </div>
    </>
  );
}

function PanelStatus({
  search,
  pending,
  error,
  query,
  hasRows,
}: {
  search: ServerSearch | null;
  pending: boolean;
  error: string | null;
  query: string;
  hasRows: boolean;
}) {
  if (error) {
    return (
      <p className="flex items-start gap-2 border-t border-line px-3 py-2.5 text-xs text-warn">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        {error}
      </p>
    );
  }
  if (!search) {
    return (
      <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
        <LoaderCircle className="size-3.5 animate-spin" />
        Loading the FiveM server list…
      </p>
    );
  }
  if (pending) {
    return <p className="border-t border-line px-3 py-1.5 text-[11px] text-subtle">Searching…</p>;
  }
  if (!hasRows) {
    return (
      <p className="px-3 py-3 text-xs text-muted">
        No servers match “{query}”. Paste the server's IP:port or cfx.re link to use it anyway.
      </p>
    );
  }
  return (
    <p className="border-t border-line px-3 py-1.5 text-[11px] text-subtle">
      {query
        ? `${number.format(search.matches)} ${search.matches === 1 ? "server matches" : "servers match"}`
        : "Most popular servers"}
      {` · ${number.format(search.total)} servers online`}
    </p>
  );
}
