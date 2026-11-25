import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { executionStatus, planSplit, type EngineRule } from '../src/engine.ts';
import { formatMoney, formatPercent, parseMajor, parsePercent, shareOf } from '../src/money.ts';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const rule = (
  id: string,
  method: 'fixed' | 'percentage',
  value: bigint,
  priority: number,
  order = 0,
  extra: Partial<EngineRule> = {},
): EngineRule => ({
  id,
  destinationKey: `d:${id}`,
  method,
  value,
  priority,
  createdAt: at(order),
  ...extra,
});

describe('planSplit', () => {
  it('splits the brief’s example: 600,000 with 10%, 100,000, 50,000 and 200,000', () => {
    const plan = planSplit({
      base: 60_000_000n,
      available: 60_000_000n,
      rules: [
        rule('tithe', 'percentage', 1000n, 1),
        rule('mother', 'fixed', 10_000_000n, 2),
        rule('brother', 'fixed', 5_000_000n, 3),
        rule('savings', 'fixed', 20_000_000n, 4),
      ],
    });
    expect(plan.allocations.map((a) => a.allocated)).toEqual([
      6_000_000n,
      10_000_000n,
      5_000_000n,
      20_000_000n,
    ]);
    expect(plan.remainder).toBe(19_000_000n);
  });

  it('takes percentages from the original salary, not from what is left', () => {
    const plan = planSplit({
      base: 1000n,
      available: 1000n,
      rules: [rule('a', 'fixed', 500n, 1), rule('b', 'percentage', 5000n, 2)],
    });
    expect(plan.allocations[1]).toMatchObject({ requested: 500n, allocated: 500n, outcome: 'allocate' });
    expect(plan.remainder).toBe(0n);
  });

  it('skips an unaffordable rule in full and keeps evaluating later ones', () => {
    const plan = planSplit({
      base: 1000n,
      available: 1000n,
      rules: [rule('a', 'fixed', 700n, 1), rule('b', 'fixed', 400n, 2), rule('c', 'fixed', 300n, 3)],
    });
    expect(plan.allocations.map((a) => [a.outcome, a.skipReason])).toEqual([
      ['allocate', undefined],
      ['skip', 'insufficient_funds'],
      ['allocate', undefined],
    ]);
    expect(plan.allocations[1]).toMatchObject({ requested: 400n, allocated: 0n, availableBefore: 300n });
    expect(plan.remainder).toBe(0n);
  });

  it('skips a percentage that no longer fits the remaining funds', () => {
    const plan = planSplit({
      base: 1000n,
      available: 1000n,
      rules: [rule('a', 'fixed', 900n, 1), rule('b', 'percentage', 2000n, 2)],
    });
    expect(plan.allocations[1]).toMatchObject({
      requested: 200n,
      skipReason: 'insufficient_funds',
      availableBefore: 100n,
    });
  });

  it('runs the earlier-created rule first when priorities are equal', () => {
    const plan = planSplit({
      base: 100n,
      available: 100n,
      rules: [rule('late', 'fixed', 100n, 1, 9), rule('early', 'fixed', 100n, 1, 1)],
    });
    expect(plan.allocations.map((a) => [a.ruleId, a.outcome])).toEqual([
      ['early', 'allocate'],
      ['late', 'skip'],
    ]);
  });

  it('rounds percentages down and keeps the odd kobo in the salary account', () => {
    const plan = planSplit({
      base: 100n,
      available: 100n,
      rules: [
        rule('a', 'percentage', 3333n, 1),
        rule('b', 'percentage', 3333n, 2),
        rule('c', 'percentage', 3334n, 3),
      ],
    });
    expect(plan.allocations.map((a) => a.allocated)).toEqual([33n, 33n, 33n]);
    expect(plan.remainder).toBe(1n);
  });

  it('never pays the same destination twice from one salary payment', () => {
    const plan = planSplit({
      base: 1000n,
      available: 400n,
      rules: [
        rule('a', 'fixed', 100n, 1),
        rule('b', 'fixed', 100n, 2),
        rule('c', 'fixed', 100n, 3, 0, { destinationKey: 'd:b' }),
      ],
      alreadyAllocated: new Set(['d:a']),
    });
    expect(plan.allocations.map((a) => a.skipReason)).toEqual([
      'already_allocated',
      undefined,
      'already_allocated',
    ]);
  });

  it('honours limits and blocked destinations, and skips amounts that round to zero', () => {
    const plan = planSplit({
      base: 10n,
      available: 10n,
      rules: [
        rule('a', 'fixed', 5n, 1, 0, { maxAmount: 4n }),
        rule('b', 'fixed', 5n, 2, 0, { blocked: 'destination_unavailable' }),
        rule('c', 'percentage', 1n, 3),
      ],
    });
    expect(plan.allocations.map((a) => a.skipReason)).toEqual([
      'limit_exceeded',
      'destination_unavailable',
      'amount_rounds_to_zero',
    ]);
  });

  it('counts external rules against the daily transfer budget, and wallets not at all', () => {
    const plan = planSplit({
      base: 100n,
      available: 100n,
      transferBudget: 50n,
      rules: [
        rule('a', 'fixed', 40n, 1, 0, { external: true }),
        rule('b', 'fixed', 20n, 2, 0, { external: true }),
        rule('c', 'fixed', 40n, 3),
        rule('d', 'fixed', 10n, 4, 0, { external: true }),
      ],
    });
    expect(plan.allocations.map((a) => a.skipReason)).toEqual([
      undefined,
      'limit_exceeded',
      undefined,
      undefined,
    ]);
  });

  it('refuses to allocate more than the salary payment', () => {
    expect(() => planSplit({ base: 10n, available: 11n, rules: [] })).toThrow(RangeError);
  });

  it('holds its invariants for any input', () => {
    const ruleArb = fc
      .record({
        method: fc.constantFrom('fixed' as const, 'percentage' as const),
        fixed: fc.bigInt({ min: 1n, max: 2_000_000_000n }),
        bps: fc.bigInt({ min: 1n, max: 10_000n }),
        priority: fc.integer({ min: 1, max: 10 }),
        order: fc.integer({ min: 0, max: 50 }),
      })
      .map((r) => ({
        method: r.method,
        value: r.method === 'fixed' ? r.fixed : r.bps,
        priority: r.priority,
        order: r.order,
      }));

    fc.assert(
      fc.property(
        fc.array(ruleArb, { maxLength: 25 }),
        fc.bigInt({ min: 0n, max: 5_000_000_000n }),
        fc.integer({ min: 0, max: 100 }),
        (arb, base, pct) => {
          const available = (base * BigInt(pct)) / 100n;
          const rules = arb.map((r, i) => rule(`r${i}`, r.method, r.value, r.priority, r.order));
          const plan = planSplit({ base, available, rules });
          const sum = plan.allocations.reduce((s, a) => s + a.allocated, 0n);
          expect(sum).toBe(plan.totalAllocated);
          expect(sum + plan.remainder).toBe(available);
          expect(plan.remainder >= 0n).toBe(true);
          for (const a of plan.allocations)
            expect(a.allocated === 0n || a.allocated === a.requested).toBe(true);
          for (const a of plan.allocations)
            if (a.skipReason === 'insufficient_funds') expect(a.requested > a.availableBefore).toBe(true);
          expect(planSplit({ base, available, rules: [...rules].reverse() })).toEqual(plan);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('executionStatus', () => {
  it.each([
    [['success', 'success'], 'successful'],
    [['success', 'skipped'], 'partially_completed'],
    [['success', 'failed'], 'partially_completed'],
    [['skipped', 'failed'], 'failed'],
    [['success', 'pending'], 'pending'],
    [['success', 'reversed'], 'partially_completed'],
  ] as const)('%j is %s', (input, expected) => expect(executionStatus([...input])).toBe(expected));
});

describe('money', () => {
  it('parses and formats without floating point', () => {
    expect(parseMajor('600,000')).toBe(60_000_000);
    expect(parseMajor('0.1')).toBe(10);
    expect(parseMajor('1,234.56')).toBe(123_456);
    for (const bad of ['', '-1', '1.234', 'abc', '1e5']) expect(parseMajor(bad)).toBeNull();
    expect(formatMoney(123_456)).toBe('₦1,234.56');
    expect(formatMoney(-5n)).toBe('-₦0.05');
    expect(parsePercent('12.5')).toBe(1250);
    expect(parsePercent('100.01')).toBeNull();
    expect(formatPercent(1250)).toBe('12.5%');
    expect(shareOf(999n, 3333)).toBe(332n);
  });
});
