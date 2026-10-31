interface Props {
  onClose: () => void
}

export function HelpDialog({ onClose }: Props) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="How it works">
      <div className="modal help">
        <header>
          <h2>How it works</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <ol>
          <li>
            <b>Get a vanilla pack.</b> The app works from GTA V's original gun sounds, kept in its own folder, so sound mods in your game
            never change ▶ Original. On first launch, <b>make one from GTA V</b> (the app copies the original sounds and gun data out of
            your install once, using CodeWalker and the keys in your own <span className="mono">gta5.exe</span>; verify the game files first
            if your game is modded) or <b>use a vanilla pack</b>: a .zip the app made, which works on any PC without GTA V, or original{' '}
            <span className="mono">WEAPONS_PLAYER.rpf</span> / <span className="mono">RESIDENT.rpf</span> you kept.{' '}
            <b>Change vanilla pack…</b> saves it as a .zip to move it.
          </li>
          <li>
            <b>Pick a gun.</b> You see every file it uses, under the part it belongs to (gunshot, distant report, echo, reload…), each with
            a short description of what it is — “Variation 2 of 3 (40% of shots)”, “Far away”, “Left channel” — and who hears it: you,
            others (other players and NPCs) or everyone. It all comes from the game's own audio data.
          </li>
          <li>
            <b>Confirm it in game.</b> <b>Identify in game…</b> builds a test pack where every sound says its code, like “pistol 4”. Install
            it, play, and type the codes you hear into “What did I hear?” — this also catches sounds the game code or scripts play by name,
            which no data file explains. Remove the test pack afterwards.
          </li>
          <li>
            <b>Replace sounds.</b> Select a part (or “Select all”), add a WAV/MP3/OGG/FLAC and assign it — or drop the file straight onto a
            part. A replacement changes exactly the files you select; “Yours”, “Others'” and “Only this gun's” pick quickly. Many shots
            share generic layers with other guns: those files say “shared with …”, and the app asks before changing another gun. Trim, fade,
            normalize and resample on the right.
          </li>
          <li>
            <b>Preview.</b> ▶ Original and ▶ Yours build the shot from the game's sound data: every layer, random variation, level, pitch,
            delay, filter, mix category, distance curve, crossfade and envelope, single or in a burst (full auto uses the gun's rapid fire
            sound). Pick how far away you hear it, outdoors, indoors or in a tunnel, and who fires it. Some things only the game engine
            decides (its reverb, where echoes come from, occlusion); the preview says what it approximated. To check, use{' '}
            <b>Compare with in-game recording…</b> with a recording of the real gun.
          </li>
          <li>
            <b>Export.</b> The app rebuilds the game's sound archives with your sounds — <span className="mono">WEAPONS_PLAYER.rpf</span>{' '}
            and <span className="mono">RESIDENT.rpf</span> — into a folder you choose. Drag them into{' '}
            <span className="mono">%localappdata%\FiveM\FiveM.app\mods</span> for FiveM, or{' '}
            <span className="mono">GTA V\mods\x64\audio\sfx</span> for single player with OpenIV. Don't overwrite the originals in the game
            folder.
          </li>
        </ol>
        <p className="small muted">
          Everything you don't change is copied over from the vanilla pack unchanged. Change both your gun and what others hear, or other
          players may still hear vanilla shots. Always test in-game with a second client.
        </p>
        <p className="small muted">Your projects (.gunpack) keep your own audio files, never game files.</p>
        <p className="small muted">
          Game files are read with CodeWalker by dexyfex (github.com/dexyfex/CodeWalker), bundled with this app. See THIRD_PARTY_NOTICES.md.
        </p>
      </div>
    </div>
  )
}
