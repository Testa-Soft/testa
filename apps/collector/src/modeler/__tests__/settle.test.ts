import { describe, expect, it } from 'bun:test';
import { chToIso, settledWatermark, stopSettled } from '../settle.ts';

const START = Date.parse('2026-11-21T17:28:00.470Z');

describe('settledWatermark', () => {
  it('is run start − settle, behind a newer event that may still be buffered (leadcheck 17:28 run)', () => {
    // That run saw a flushed event at 17:27:37.849 while an older one was still buffered.
    expect(settledWatermark(START, 60)).toBe('2026-11-21T17:27:00.470Z');
  });

  it('settle 0 is the run start', () => {
    expect(settledWatermark(START, 0)).toBe('2026-11-21T17:28:00.470Z');
  });
});

describe('stopSettled', () => {
  it('is false for a run that starts within the settle window after the stop', () => {
    expect(stopSettled('2026-11-21 17:27:30.000', START, 60)).toBe(false);
  });

  it('is true once the settle window has passed since the stop', () => {
    expect(stopSettled('2026-11-21 17:27:00.470', START, 60)).toBe(true);
    expect(stopSettled('2026-11-21 17:20:00.000', START, 60)).toBe(true);
  });

  it('is false for an unparseable stop time', () => {
    expect(stopSettled('not a date', START, 60)).toBe(false);
  });
});

describe('chToIso', () => {
  it('reads a ClickHouse DateTime64 string as UTC', () => {
    expect(chToIso('2026-10-03 09:20:00.180')).toBe('2026-10-03T09:20:00.180Z');
  });
});
