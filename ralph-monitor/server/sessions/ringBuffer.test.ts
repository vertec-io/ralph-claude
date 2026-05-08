// RingBuffer tests — US-005c.

import { describe, expect, test } from 'bun:test'
import { RingBuffer } from './ringBuffer'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function decode(u8: Uint8Array): string {
  return new TextDecoder().decode(u8)
}

describe('RingBuffer', () => {
  test('constructor rejects non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow()
    expect(() => new RingBuffer(-1)).toThrow()
    expect(() => new RingBuffer(Number.NaN)).toThrow()
    expect(() => new RingBuffer(Number.POSITIVE_INFINITY)).toThrow()
  })

  test('append small chunks under capacity: snapshot is the concatenation, byteLength matches', () => {
    const rb = new RingBuffer(64)
    rb.append(bytes('hello '))
    rb.append(bytes('world'))
    expect(rb.byteLength()).toBe(11)
    expect(decode(rb.snapshot())).toBe('hello world')
  })

  test('empty append is a no-op (does not allocate or grow)', () => {
    const rb = new RingBuffer(8)
    rb.append(new Uint8Array(0))
    expect(rb.byteLength()).toBe(0)
    expect(rb.snapshot().byteLength).toBe(0)
    rb.append(bytes('abc'))
    rb.append(new Uint8Array(0))
    expect(rb.byteLength()).toBe(3)
    expect(decode(rb.snapshot())).toBe('abc')
  })

  test('chunk LARGER than capacity is partial-dropped to last `capacity` bytes', () => {
    const rb = new RingBuffer(4)
    rb.append(bytes('abcdefghij')) // 10 bytes; capacity 4 -> keep 'ghij'
    expect(rb.byteLength()).toBe(4)
    expect(decode(rb.snapshot())).toBe('ghij')
  })

  test('many small chunks summing > capacity: oldest bytes drop, last `capacity` preserved', () => {
    const rb = new RingBuffer(5)
    rb.append(bytes('abc'))   // 3 in buffer: 'abc'
    rb.append(bytes('de'))    // 5 in buffer: 'abcde'
    rb.append(bytes('fg'))    // 7 -> drop head 'abc' (>=2 overshoot, drop whole head), buf: 'defg' (4)
    rb.append(bytes('h'))     // 5: 'defgh'
    rb.append(bytes('ij'))    // 7 -> partial drop 'de' from head -> 'fghij' (5)
    expect(rb.byteLength()).toBe(5)
    expect(decode(rb.snapshot())).toBe('fghij')
  })

  test('capacity = 1, append "abc" → snapshot is "c"', () => {
    const rb = new RingBuffer(1)
    rb.append(bytes('abc'))
    expect(rb.byteLength()).toBe(1)
    expect(decode(rb.snapshot())).toBe('c')
  })

  test('append exactly fills capacity: no eviction', () => {
    const rb = new RingBuffer(5)
    rb.append(bytes('hello'))
    expect(rb.byteLength()).toBe(5)
    expect(decode(rb.snapshot())).toBe('hello')
  })

  test('clear() resets to empty', () => {
    const rb = new RingBuffer(10)
    rb.append(bytes('hello'))
    expect(rb.byteLength()).toBe(5)
    rb.clear()
    expect(rb.byteLength()).toBe(0)
    expect(rb.snapshot().byteLength).toBe(0)
    // Post-clear append works.
    rb.append(bytes('xy'))
    expect(decode(rb.snapshot())).toBe('xy')
  })

  test('snapshot returns a freshly-allocated buffer (caller may mutate freely)', () => {
    const rb = new RingBuffer(8)
    rb.append(bytes('abcd'))
    const snap = rb.snapshot()
    snap[0] = 0xff
    // Internal state unchanged.
    expect(decode(rb.snapshot())).toBe('abcd')
  })

  test('partial-drop at exact head boundary: drops whole head, no slice', () => {
    const rb = new RingBuffer(5)
    rb.append(bytes('abc')) // 3
    rb.append(bytes('de'))  // 5 (full)
    rb.append(bytes('fgh')) // 8 -> drop 'abc' whole (5 left: 'defgh')
    expect(rb.byteLength()).toBe(5)
    expect(decode(rb.snapshot())).toBe('defgh')
  })

  test('repeated overflow stabilizes at capacity', () => {
    const rb = new RingBuffer(10)
    for (let i = 0; i < 100; i++) rb.append(bytes('xx')) // 200 bytes total
    expect(rb.byteLength()).toBe(10)
    // Last 10 bytes are all 'x'.
    expect(decode(rb.snapshot())).toBe('xxxxxxxxxx')
  })
})
