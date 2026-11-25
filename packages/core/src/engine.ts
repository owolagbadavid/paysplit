import { shareOf, type Minor } from './money.ts';

export type AllocationMethod = 'fixed' | 'percentage';

export type SkipReason =
  | 'insufficient_funds'
  | 'amount_rounds_to_zero'
  | 'limit_exceeded'
  | 'destination_unavailable'
  | 'already_allocated';

export interface EngineRule {
  id: string;
  destinationKey: string;
  method: AllocationMethod;
  /** Minor units for fixed rules, basis points for percentage rules. */
  value: bigint;
  priority: number;
  /** Tie-breaker for equal priorities: the earlier-created rule runs first. */
  createdAt: Date;
  /** Reason decided outside the engine, such as a removed destination or a transfer limit. */
  blocked?: SkipReason | undefined;
  /** Largest amount this rule may move in one go, or undefined for no limit. */
  maxAmount?: Minor | undefined;
  /** Whether it leaves PaySplit and so counts against `transferBudget`. */
  external?: boolean | undefined;
}

export interface PlannedAllocation {
  ruleId: string;
  destinationKey: string;
  position: number;
  requested: Minor;
  allocated: Minor;
  availableBefore: Minor;
  outcome: 'allocate' | 'skip';
  skipReason?: SkipReason;
}

export interface SplitPlan {
  base: Minor;
  available: Minor;
  allocations: PlannedAllocation[];
  totalAllocated: Minor;
  remainder: Minor;
}

export interface SplitInput {
  /** Original confirmed salary payment. Every percentage is taken from this, whatever ran before it. */
  base: Minor;
  /** Funds that may be allocated now. Less than `base` when part of the salary is already allocated. */
  available: Minor;
  rules: readonly EngineRule[];
  /** Destinations that already received, or have in flight, money from this salary payment. */
  alreadyAllocated?: ReadonlySet<string>;
  /** What external transfers may still move today, or undefined for no limit. */
  transferBudget?: Minor | undefined;
}

export function orderRules<T extends Pick<EngineRule, 'priority' | 'createdAt' | 'id'>>(
  rules: readonly T[],
): T[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Decides how one salary payment is divided. Pure and deterministic, so the preview a user approves and the
 * execution that moves money come from the same function.
 *
 * Rules run in priority order. A rule is funded in full or skipped, never partially, and a skipped rule does
 * not stop the ones after it. Percentages use the original salary and round down to a whole minor unit, so
 * `totalAllocated + remainder === available` always holds and the remainder stays in the salary account.
 */
export function planSplit(input: SplitInput): SplitPlan {
  if (input.base < 0n || input.available < 0n) throw new RangeError('Amounts cannot be negative');
  if (input.available > input.base) throw new RangeError('Available funds cannot exceed the salary payment');

  let remaining = input.available;
  let budget = input.transferBudget;
  const taken = new Set(input.alreadyAllocated ?? []);

  const allocations = orderRules(input.rules).map((rule, index): PlannedAllocation => {
    const requested = rule.method === 'fixed' ? rule.value : shareOf(input.base, Number(rule.value));
    const common = {
      ruleId: rule.id,
      destinationKey: rule.destinationKey,
      position: index + 1,
      requested,
      availableBefore: remaining,
    };
    const skip = (skipReason: SkipReason): PlannedAllocation => ({
      ...common,
      allocated: 0n,
      outcome: 'skip',
      skipReason,
    });

    if (taken.has(rule.destinationKey)) return skip('already_allocated');
    if (rule.blocked) return skip(rule.blocked);
    if (requested <= 0n) return skip('amount_rounds_to_zero');
    if (rule.maxAmount !== undefined && requested > rule.maxAmount) return skip('limit_exceeded');
    if (rule.external && budget !== undefined && requested > budget) return skip('limit_exceeded');
    if (requested > remaining) return skip('insufficient_funds');

    remaining -= requested;
    if (rule.external && budget !== undefined) budget -= requested;
    taken.add(rule.destinationKey);
    return { ...common, allocated: requested, outcome: 'allocate' };
  });

  return {
    base: input.base,
    available: input.available,
    allocations,
    totalAllocated: input.available - remaining,
    remainder: remaining,
  };
}

export type AllocationStatus = 'pending' | 'success' | 'failed' | 'skipped' | 'reversed';
export type ExecutionStatus = 'pending' | 'successful' | 'partially_completed' | 'failed';

/** Overall status of an execution from the statuses of its allocations. */
export function executionStatus(statuses: readonly AllocationStatus[]): ExecutionStatus {
  if (statuses.some((s) => s === 'pending')) return 'pending';
  const succeeded = statuses.filter((s) => s === 'success').length;
  if (succeeded === 0) return 'failed';
  return succeeded === statuses.length ? 'successful' : 'partially_completed';
}

/** Total of active percentage rules in basis points. Above 10000 the rules can never all be funded. */
export function totalBps(rules: readonly { method: AllocationMethod; value: bigint | number }[]): number {
  return rules.reduce((sum, r) => sum + (r.method === 'percentage' ? Number(r.value) : 0), 0);
}
