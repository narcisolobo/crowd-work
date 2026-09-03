import { describe, it, expect } from 'vitest';
import { formatStubDate, formatTime } from './format';

describe('formatStubDate', () => {
  it('formats a date string into day/date/month parts', () => {
    expect(formatStubDate('2026-09-08')).toEqual({
      day: 'TUE',
      date: '08',
      month: 'SEP',
    });
  });

  it('pads single-digit dates', () => {
    expect(formatStubDate('2026-09-02')).toEqual({
      day: 'WED',
      date: '02',
      month: 'SEP',
    });
  });

  it('does not shift the date across a UTC/local timezone boundary', () => {
    expect(formatStubDate('2026-01-01').date).toBe('01');
  });
});

describe('formatTime', () => {
  it('formats a morning time', () => {
    expect(formatTime('09:30')).toBe('9:30 AM');
  });

  it('formats an afternoon time', () => {
    expect(formatTime('20:00')).toBe('8:00 PM');
  });

  it('formats noon as 12 PM', () => {
    expect(formatTime('12:00')).toBe('12:00 PM');
  });

  it('formats midnight as 12 AM', () => {
    expect(formatTime('00:00')).toBe('12:00 AM');
  });

  it('handles a time string with seconds', () => {
    expect(formatTime('19:30:00')).toBe('7:30 PM');
  });
});
