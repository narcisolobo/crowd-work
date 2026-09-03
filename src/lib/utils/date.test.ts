import { describe, it, expect } from 'vitest';
import { getTodayInLA } from './date';

describe('getTodayInLA', () => {
  it('returns the LA calendar date, not the UTC calendar date, in the evening', () => {
    // 22:48 PDT on Sep 2 is already 05:48 UTC on Sep 3.
    const eveningInLA = new Date('2026-09-03T05:48:11.894Z');
    expect(getTodayInLA(eveningInLA)).toBe('2026-09-02');
  });

  it('returns the LA calendar date in the morning, before UTC catches up', () => {
    // 08:00 PDT on Sep 2 is 15:00 UTC on Sep 2 — both agree here.
    const morningInLA = new Date('2026-09-02T15:00:00.000Z');
    expect(getTodayInLA(morningInLA)).toBe('2026-09-02');
  });

  it('crosses into the next LA day only once LA itself has', () => {
    // 00:30 PDT on Sep 3 is 07:30 UTC on Sep 3 — both agree Sep 3 has begun.
    const justAfterMidnightInLA = new Date('2026-09-03T07:30:00.000Z');
    expect(getTodayInLA(justAfterMidnightInLA)).toBe('2026-09-03');
  });
});
