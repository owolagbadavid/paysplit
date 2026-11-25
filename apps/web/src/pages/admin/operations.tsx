import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Scale } from 'lucide-react';
import { useState } from 'react';
import { api, get, query as qs, queryClient } from '../../lib/api.ts';
import { ago, dateTime, title } from '../../lib/format.ts';
import type { AuditRow, Issue, Page } from '../../lib/types.ts';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  FormError,
  Notice,
  PageHeader,
  Pagination,
  Panel,
} from '../../ui/core.tsx';
import { Cell, Table } from './overview.tsx';

interface Check {
  kind: string;
  severity: string;
  detail: string | null;
}

function Audit() {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin', 'audit', page],
    queryFn: () => get<Page<AuditRow>>(`/v1/admin/audit${qs({ page, pageSize: 15 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <Panel flush title="Audit log">
        <Async query={list} rows={6}>
          {(data) => (
            <Table min="min-w-[860px]" head={['When', 'Action', 'By', 'User', 'Target', 'Address']}>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <Cell className="whitespace-nowrap">{dateTime(a.createdAt)}</Cell>
                  <Cell className="font-medium">{title(a.action.replaceAll('.', ': '))}</Cell>
                  <Cell>{title(a.actorType)}</Cell>
                  <Cell className="num">{a.userId?.slice(0, 8) ?? ''}</Cell>
                  <Cell>{a.targetType ? `${title(a.targetType)} ${a.targetId?.slice(0, 8)}` : ''}</Cell>
                  <Cell className="num">{a.ip ?? ''}</Cell>
                </tr>
              ))}
            </Table>
          )}
        </Async>
      </Panel>
      {list.data && <Pagination {...list.data} noun="events" onPage={setPage} />}
    </>
  );
}

export function AdminOperations() {
  const issues = useQuery({
    queryKey: ['admin', 'issues'],
    queryFn: () => get<{ items: Issue[] }>('/v1/admin/reconciliation'),
  });
  const run = useMutation({
    mutationFn: () => api<{ checks: Check[] }>('POST', '/v1/admin/reconciliation/run'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const failed = run.data?.checks.filter((c) => c.detail && c.severity !== 'info') ?? [];
  return (
    <>
      <PageHeader
        title="Operations"
        crumbs={[{ label: 'Dashboard', to: '/admin' }, { label: 'Operations' }]}
        actions={
          <Button
            icon={<Scale className="size-4" aria-hidden />}
            busy={run.isPending}
            onClick={() => run.mutate()}
          >
            Check the books
          </Button>
        }
      />
      <div className="space-y-5">
        <FormError error={run.error} />
        {run.data &&
          (failed.length === 0 ? (
            <Notice tone="good" title="The books balance">
              {run.data.checks.length} checks ran against the ledger, transfers and the provider.
            </Notice>
          ) : (
            <Notice tone="bad" title={`${failed.length} checks failed`}>
              {failed.map((c) => `${title(c.kind)}: ${c.detail}`).join('. ')}
            </Notice>
          ))}
        <Panel flush title="Reconciliation issues">
          <Async query={issues} rows={4}>
            {({ items }) =>
              items.length === 0 ? (
                <EmptyState icon={<CheckCircle2 className="size-5" />} title="No issues found">
                  Mismatches with the provider, stuck jobs and unknown payments appear here.
                </EmptyState>
              ) : (
                <Table head={['Issue', 'Detail', 'Severity', 'Seen', 'Status']}>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <Cell className="font-medium">{title(i.kind)}</Cell>
                      <Cell>
                        {i.detail}
                        <span className="block text-[12px] break-all text-muted">{i.subject}</span>
                      </Cell>
                      <Cell>
                        <Badge
                          tone={
                            i.severity === 'critical' ? 'bad' : i.severity === 'high' ? 'warn' : 'neutral'
                          }
                        >
                          {title(i.severity)}
                        </Badge>
                      </Cell>
                      <Cell className="whitespace-nowrap">
                        {i.occurrences}×, {ago(i.updatedAt)}
                      </Cell>
                      <Cell>
                        <Badge tone={i.status === 'open' ? 'warn' : 'good'}>{title(i.status)}</Badge>
                      </Cell>
                    </tr>
                  ))}
                </Table>
              )
            }
          </Async>
        </Panel>
        <Audit />
      </div>
    </>
  );
}
