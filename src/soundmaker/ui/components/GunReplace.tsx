import { useMemo, useRef, useState } from "react";
import type { GunSection } from "../../core/describe";
import {
  planGunReplace,
  renderShotVersion,
  SHOT_KIND_LABELS,
  SHOT_KIND_NOTES,
  type ReplacePlan,
  type ShotKind,
} from "../../core/gunReplace";
import type { AudioData } from "../../core/wav";
import { player } from "../audio";
import type { SourceEntry } from "../model";

interface Props {
  gun: string;
  source: SourceEntry;
  sections: GunSection[];
  playing: string | null;
  onClose: () => void;
  onReplace: (plan: ReplacePlan) => void;
}

const MAX_NAMES = 6;

/** Shows what one dropped gunshot will fill on a gun, and the versions made for each part. */
export function GunReplace({ gun, source, sections, playing, onClose, onReplace }: Props) {
  const [includeShared, setIncludeShared] = useState(false);
  const plan = useMemo(
    () => planGunReplace(sections, { includeShared }),
    [sections, includeShared],
  );
  const versions = useRef(new Map<ShotKind, AudioData>()).current;
  const listen = (kind: ShotKind): void => {
    let v = versions.get(kind);
    if (!v) versions.set(kind, (v = renderShotVersion(source.audio, kind)));
    player.toggle(`gunreplace:${kind}`, v.channels[0], v.sampleRate);
  };
  const files = plan.groups.reduce((n, g) => n + g.refs.length, 0);
  const names =
    plan.sharedGuns.slice(0, MAX_NAMES).join(", ") +
    (plan.sharedGuns.length > MAX_NAMES ? ` and ${plan.sharedGuns.length - MAX_NAMES} more` : "");

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Replace whole gun">
      <div className="modal">
        <header>
          <h2>Replace the {gun}'s shot</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p>
          <span className="mono">{source.info.fileName}</span> goes into every part of the shot. The
          far-away and echo parts get versions made from it, so the gun doesn't sound vanilla from a
          distance.
        </p>
        {plan.groups.length ? (
          <ul className="gun-replace-list">
            {plan.groups.map((g) => (
              <li key={g.kind} className="row gap">
                <button
                  className={`btn small${playing === `gunreplace:${g.kind}` ? " playing" : ""}`}
                  onClick={() => listen(g.kind)}
                  aria-label={`Listen to the ${SHOT_KIND_LABELS[g.kind].toLowerCase()} version`}
                >
                  ▶
                </button>
                <span>
                  <strong>{SHOT_KIND_LABELS[g.kind]}</strong>{" "}
                  <span className="muted">{SHOT_KIND_NOTES[g.kind]}</span>
                </span>
                <span className="muted small grow-end">
                  {g.refs.length} {g.refs.length === 1 ? "file" : "files"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="warn-text">
            Every shot file of this gun is shared with other guns. Tick the box below to change them
            anyway.
          </p>
        )}
        {plan.shared.length > 0 && (
          <label className="row gap small">
            <input
              type="checkbox"
              checked={includeShared}
              onChange={(e) => setIncludeShared(e.target.checked)}
            />
            <span>
              Also change {plan.shared.length} shared {plan.shared.length === 1 ? "file" : "files"}{" "}
              (part of {names}&apos;s shot too)
            </span>
          </label>
        )}
        <p className="muted small">
          Reloads, casings and handling sounds aren&apos;t touched. You can fine-tune or swap any
          part afterwards.
        </p>
        <footer className="row gap end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onReplace(plan)} disabled={files === 0}>
            Replace {files} {files === 1 ? "file" : "files"}
          </button>
        </footer>
      </div>
    </div>
  );
}
