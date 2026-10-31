/** Little-endian binary helpers shared by the AWC and WAV codecs. */

export class ByteReader {
  readonly view: DataView
  pos = 0

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get length(): number {
    return this.bytes.byteLength
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.byteLength) {
      throw new RangeError(`Unexpected end of data at offset ${this.pos} (need ${n} bytes)`)
    }
  }

  u8(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  u64(): bigint {
    this.need(8)
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    return v
  }

  /** Returns a copy so callers can mutate it freely. */
  bytesAt(offset: number, size: number): Uint8Array {
    if (offset < 0 || size < 0 || offset + size > this.bytes.byteLength) {
      throw new RangeError(`Range ${offset}+${size} is outside the data (${this.bytes.byteLength} bytes)`)
    }
    return this.bytes.slice(offset, offset + size)
  }
}

export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  pos = 0

  constructor(initialSize = 1024) {
    this.buf = new Uint8Array(Math.max(16, initialSize))
    this.view = new DataView(this.buf.buffer)
  }

  private ensure(n: number): void {
    const needed = this.pos + n
    if (needed <= this.buf.byteLength) return
    let size = this.buf.byteLength * 2
    while (size < needed) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): void {
    this.ensure(1)
    this.view.setUint8(this.pos++, v)
  }

  u16(v: number): void {
    this.ensure(2)
    this.view.setUint16(this.pos, v, true)
    this.pos += 2
  }

  i16(v: number): void {
    this.ensure(2)
    this.view.setInt16(this.pos, v, true)
    this.pos += 2
  }

  u32(v: number): void {
    this.ensure(4)
    this.view.setUint32(this.pos, v >>> 0, true)
    this.pos += 4
  }

  i32(v: number): void {
    this.ensure(4)
    this.view.setInt32(this.pos, v, true)
    this.pos += 4
  }

  u64(v: bigint): void {
    this.ensure(8)
    this.view.setBigUint64(this.pos, v, true)
    this.pos += 8
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.byteLength)
    this.buf.set(data, this.pos)
    this.pos += data.byteLength
  }

  zeros(n: number): void {
    this.ensure(n)
    this.buf.fill(0, this.pos, this.pos + n)
    this.pos += n
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xff)
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

export function padTo(pos: number, align: number): number {
  return align > 0 ? (align - (pos % align)) % align : 0
}
