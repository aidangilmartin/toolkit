import { useState } from 'react'
import { findByCode, type IdCode, type IdCodes } from '@core/idpack'

interface Props {
  codes: IdCodes
  onFound: (code: IdCode) => void
  compact?: boolean
}

/** "What did I hear?": type a code from the ID pack ("pistol 4") to jump to that sound. */
export function CodeLookup({ codes, onFound, compact }: Props) {
  const [text, setText] = useState('')
  const [miss, setMiss] = useState(false)
  const find = (): void => {
    const hit = findByCode(codes, text)
    setMiss(!hit)
    if (hit) onFound(hit)
  }
  return (
    <form
      className={`code-lookup${compact ? ' compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        find()
      }}
    >
      <label className="small muted" htmlFor="code-lookup-input">
        What did I hear?
      </label>
      <div className="row gap">
        <input
          id="code-lookup-input"
          value={text}
          placeholder='e.g. "pistol 4"'
          onChange={(e) => {
            setText(e.target.value)
            setMiss(false)
          }}
          aria-label="ID pack code"
        />
        <button className="btn small" type="submit" disabled={!text.trim()}>
          Find
        </button>
      </div>
      {miss && <p className="small error">No sound has that code.</p>}
    </form>
  )
}
