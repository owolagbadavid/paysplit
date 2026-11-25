export const DEFAULT_TIMEZONE = 'Africa/Lagos';

export interface CalendarDate {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function localDate(instant: Date, timeZone = DEFAULT_TIMEZONE): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function isoDate(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function dayNumber(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Expected salary date in a month. Day 31 falls back to the last day of shorter months. */
export function expectedDateIn(year: number, month: number, salaryDay: number): CalendarDate {
  return { year, month, day: Math.min(salaryDay, daysInMonth(year, month)) };
}

/** Next expected salary date on or after today in the user's timezone. An estimate, never a trigger. */
export function nextExpectedDate(salaryDay: number, now: Date, timeZone = DEFAULT_TIMEZONE): CalendarDate {
  const today = localDate(now, timeZone);
  const current = expectedDateIn(today.year, today.month, salaryDay);
  if (dayNumber(current) >= dayNumber(today)) return current;
  const next = shiftMonth(today.year, today.month, 1);
  return expectedDateIn(next.year, next.month, salaryDay);
}

/**
 * Pay cycle (`YYYY-MM`) a payment belongs to. With an expected day, it is the month whose expected date is
 * nearest to the payment, so a salary due on the 28th that lands on the 1st still counts for the month it
 * was due. A tie goes to the earlier month. Without an expected day, it is the calendar month.
 */
export function payCycleFor(paidAt: Date, salaryDay: number | null, timeZone = DEFAULT_TIMEZONE): string {
  const paid = localDate(paidAt, timeZone);
  if (salaryDay === null) return cycleKey(paid.year, paid.month);
  let best = { distance: Infinity, key: '' };
  for (const offset of [-1, 0, 1]) {
    const { year, month } = shiftMonth(paid.year, paid.month, offset);
    const distance = Math.abs(dayNumber(expectedDateIn(year, month, salaryDay)) - dayNumber(paid));
    if (distance < best.distance) best = { distance, key: cycleKey(year, month) };
  }
  return best.key;
}

export function cycleKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function addCycles(cycle: string, by: number): string {
  const [year, month] = cycle.split('-').map(Number) as [number, number];
  const next = shiftMonth(year, month, by);
  return cycleKey(next.year, next.month);
}

export const PAY_CYCLE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
