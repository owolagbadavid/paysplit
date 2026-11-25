import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, get, newKey, refreshMoney } from '../lib/api.ts';
import { date, naira, ruleValue, skipText } from '../lib/format.ts';
import type { RunNowOption } from '../lib/types.ts';
import { Async, Badge, Button, EmptyState, FormError, Modal, Notice, Select } from './core.tsx';

/** Review, then confirm. The plan's hash goes back with the request, so only what was shown can run. */
export function RunNow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [chosen, setChosen] = useState('');
  const [key, setKey] = useState(newKey);
  const query = useQuery({
    queryKey: ['splits', 'run-now'],
    queryFn: () => get<{ options: RunNowOption[] }>('/v1/splits/run-now'),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const run = useMutation({
    mutationFn: (option: RunNowOption) =>
      api<{ executionId: string }>(
        'POST',
        '/v1/splits/run-now',
        { salaryPaymentId: option.salaryPaymentId, planHash: option.planHash },
        { 'Idempotency-Key': key },
      ),
    onSuccess: async ({ executionId }) => {
      setKey(newKey());
      await refreshMoney();
      onClose();
      await navigate(`/splits/${executionId}`);
    },
    onError: (error) => {
      // A refused request did nothing, so the next try is a new one. A lost answer keeps its key and stays safe.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) setKey(newKey());
      void query.refetch();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run split now"
      subtitle="Review what will happen, then confirm"
      width="max-w-xl"
    >
      <Async query={query} rows={4}>
        {({ options }) => {
          const option = options.find((o) => o.salaryPaymentId === chosen) ?? options[0];
          if (!option)
            return (
              <EmptyState title="Nothing to split">
                Every active rule has already been funded from your salary, or there is no salary left to
                allocate.
              </EmptyState>
            );
          return (
            <div className="space-y-4">
              {options.length > 1 && (
                <Select
                  label="Salary to split"
                  value={option.salaryPaymentId}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  {options.map((o) => (
                    <option key={o.salaryPaymentId} value={o.salaryPaymentId}>
                      {naira(o.salaryAmount)} received {date(o.paidAt)}, {naira(o.available)} unallocated
                    </option>
                  ))}
                </Select>
              )}
              <dl className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['Unallocated', option.available],
                  ['Will be allocated', option.totalAllocated],
                  ['Will remain', option.remainder],
                ].map(([label, value]) => (
                  <div key={label} className="tile px-2 py-3">
                    <dt className="text-[12px] text-muted">{label}</dt>
                    <dd className="num font-semibold">{naira(value as number)}</dd>
                  </div>
                ))}
              </dl>
              <ul className="divide-y rounded-xl border">
                {option.allocations.map((a) => (
                  <li
                    key={a.ruleId}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {a.priority}. {a.ruleName}
                      </span>
                      <span className="block text-muted">
                        {ruleValue(a)} to {a.destination.name}
                      </span>
                    </span>
                    {a.skipReason ? (
                      <Badge tone="warn">{skipText(a.skipReason)}</Badge>
                    ) : (
                      <span className="num font-semibold">{naira(a.allocated)}</span>
                    )}
                  </li>
                ))}
              </ul>
              <Notice>
                Destinations already paid from this salary are left out, so nobody is paid twice.
              </Notice>
              <FormError error={run.error} />
              <div className="grid grid-cols-2 gap-3">
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  busy={run.isPending}
                  disabled={option.totalAllocated === 0}
                  onClick={() => run.mutate(option)}
                >
                  Confirm and run
                </Button>
              </div>
            </div>
          );
        }}
      </Async>
    </Modal>
  );
}
