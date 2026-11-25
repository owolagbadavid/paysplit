import { describe, expect, it } from 'vitest';
import { addCycles, isoDate, nextExpectedDate, payCycleFor } from '../src/cycle.ts';

describe('nextExpectedDate', () => {
  it('uses the last day when the month is shorter', () => {
    expect(isoDate(nextExpectedDate(31, new Date('2027-02-10T12:00:00Z')))).toBe('2027-02-28');
    expect(isoDate(nextExpectedDate(31, new Date('2028-02-10T12:00:00Z')))).toBe('2028-02-29');
  });
  it('counts today as still expected and rolls over after it', () => {
    expect(isoDate(nextExpectedDate(25, new Date('2026-11-25T08:00:00Z')))).toBe('2026-11-25');
    expect(isoDate(nextExpectedDate(25, new Date('2026-12-26T08:00:00Z')))).toBe('2027-01-25');
  });
  it('uses the user’s timezone for what today is', () => {
    expect(isoDate(nextExpectedDate(24, new Date('2026-11-24T23:30:00Z')))).toBe('2026-12-24');
  });
});

describe('payCycleFor', () => {
  it('keeps a late salary in the month it was due', () => {
    expect(payCycleFor(new Date('2026-12-01T09:00:00Z'), 28)).toBe('2026-11');
    expect(payCycleFor(new Date('2026-12-24T09:00:00Z'), 28)).toBe('2026-12');
  });
  it('gives an early salary to the month it is for', () => {
    expect(payCycleFor(new Date('2026-12-30T09:00:00Z'), 1)).toBe('2027-01');
  });
  it('uses the calendar month without an expected day', () => {
    expect(payCycleFor(new Date('2026-11-30T23:30:00Z'), null)).toBe('2026-12');
  });
  it('adds cycles across a year end', () => expect(addCycles('2026-12', 1)).toBe('2027-01'));
});
