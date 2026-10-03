import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Server } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Field, Input, Select } from "../../components/ui/form";
import { Modal } from "../../components/ui/overlay";
import { useApp } from "../../store/app";

export function ServerDialog({
  open,
  server,
  onClose,
}: {
  open: boolean;
  server: Server | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={server ? "Edit server" : "Add a server"}
      description="Pick the profile Loadout should apply before joining."
      size="sm"
    >
      {open && <ServerForm key={server?.id ?? "new"} server={server} onDone={onClose} />}
    </Modal>
  );
}

function ServerForm({ server, onDone }: { server: Server | null; onDone: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const refresh = useApp((s) => s.refresh);
  const [name, setName] = useState(server?.name ?? "");
  const [address, setAddress] = useState(server?.address ?? "");
  const [profileId, setProfileId] = useState(server?.profileId ?? profiles[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveServer({
        id: server?.id ?? "",
        name,
        address,
        profileId: profileId || null,
        lastPlayedAt: server?.lastPlayedAt ?? null,
      });
      await refresh("servers");
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Address" hint="IP:port, hostname, or a cfx.re/join link or code.">
        <Input
          autoFocus
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="cfx.re/join/abc123"
        />
      </Field>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Arena PvP EU"
          maxLength={60}
        />
      </Field>
      <Field label="Profile">
        <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">Don't change anything</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!address.trim()}>
          {server ? "Save" : "Add server"}
        </Button>
      </div>
    </form>
  );
}
