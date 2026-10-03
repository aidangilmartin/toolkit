import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Pack, PackCategory } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Field, Input, Select, Textarea } from "../../components/ui/form";
import { Modal } from "../../components/ui/overlay";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "../../lib/profile";
import { useApp } from "../../store/app";

export function EditPackDialog({ pack, onClose }: { pack: Pack | null; onClose: () => void }) {
  return (
    <Modal
      open={pack !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Pack details"
      size="sm"
    >
      {pack && <EditPackForm key={pack.id} pack={pack} onDone={onClose} />}
    </Modal>
  );
}

function EditPackForm({ pack, onDone }: { pack: Pack; onDone: () => void }) {
  const refresh = useApp((s) => s.refresh);
  const [name, setName] = useState(pack.name);
  const [category, setCategory] = useState<PackCategory>(pack.category);
  const [notes, setNotes] = useState(pack.notes);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.updatePack(pack.id, name, category, notes);
          await refresh("packs");
          onDone();
        } catch (error) {
          toast.error(errorMessage(error));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
      </Field>
      <Field
        label="Category"
        hint="Just a label for grouping. Where files go was decided on import."
      >
        <Select value={category} onChange={(e) => setCategory(e.target.value as PackCategory)}>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Where it's from, version…"
        />
      </Field>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-2 px-3 py-2">
        {pack.files.map((f) => (
          <p key={f.path} className="truncate font-mono text-[11px] text-muted" title={f.path}>
            {f.path}
          </p>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
