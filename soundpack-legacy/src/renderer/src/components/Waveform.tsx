import { useEffect, useRef } from 'react'

interface Props {
  samples: Float32Array | Int16Array | null
  height?: number
  tone?: 'original' | 'new'
  label?: string
}

/** Min/max peak drawing; redraws on resize. */
export function Waveform({ samples, height = 72, tone = 'original', label }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.floor(el.clientWidth * dpr))
      const h = Math.max(1, Math.floor(height * dpr))
      el.width = w
      el.height = h
      const g = el.getContext('2d')
      if (!g) return
      g.clearRect(0, 0, w, h)
      const style = getComputedStyle(el)
      g.fillStyle = style.getPropertyValue('--wave-axis')
      g.fillRect(0, Math.floor(h / 2), w, Math.max(1, Math.round(dpr)))
      if (!samples || samples.length === 0) return
      const scale = samples instanceof Int16Array ? 1 / 32768 : 1
      g.fillStyle = style.getPropertyValue(tone === 'new' ? '--wave-new' : '--wave-original')
      const per = samples.length / w
      for (let x = 0; x < w; x++) {
        const a = Math.floor(x * per)
        const b = Math.min(samples.length, Math.max(a + 1, Math.floor((x + 1) * per)))
        let lo = 1
        let hi = -1
        for (let i = a; i < b; i++) {
          const v = samples[i] * scale
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        const y1 = ((1 - hi) / 2) * h
        const y2 = ((1 - lo) / 2) * h
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [samples, height, tone])

  return (
    <div className="waveform">
      {label && <span className="waveform-label">{label}</span>}
      <canvas ref={canvas} style={{ height }} aria-label={label ?? 'waveform'} />
    </div>
  )
}
