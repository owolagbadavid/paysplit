import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageBody } from '../layouts/app.tsx';
import { api, get, query as qs, queryClient } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import type { Notification, Page } from '../lib/types.ts';
import { Async, Button, cx, EmptyState, PageHeader, Pagination, Panel } from '../ui/core.tsx';

const ICONS = {
  info: [Info, 'text-brand-ink'],
  success: [CheckCircle2, 'text-good'],
  warning: [AlertTriangle, 'text-warn'],
  error: [XCircle, 'text-bad'],
} as const;

export function NotificationsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['notifications', page],
    queryFn: () =>
      get<Page<Notification> & { unread: number }>(`/v1/notifications${qs({ page, pageSize: 15 })}`),
    placeholderData: keepPreviousData,
  });
  const read = useMutation({
    mutationFn: (id?: string) => api('POST', '/v1/notifications/read', id ? { id } : {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <PageBody>
      <PageHeader
        title="Notifications"
        crumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Notifications' }]}
        actions={
          <Button
            variant="outline"
            disabled={!query.data?.unread}
            busy={read.isPending && !read.variables}
            onClick={() => read.mutate(undefined)}
          >
            Mark all as read
          </Button>
        }
      />
      <Panel flush>
        <Async query={query} rows={6}>
          {(data) =>
            data.total === 0 ? (
              <EmptyState icon={<Bell className="size-5" />} title="No notifications yet">
                Salary, splits, transfers and security alerts appear here.
              </EmptyState>
            ) : (
              <ul className="divide-y">
                {data.items.map((n) => {
                  const [Icon, color] = ICONS[n.severity];
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (!n.readAt) read.mutate(n.id);
                          if (n.link) void navigate(n.link);
                        }}
                        className={cx(
                          'flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-brand-wash',
                          !n.readAt && 'bg-brand-wash',
                        )}
                      >
                        <Icon className={cx('mt-0.5 size-5 shrink-0', color)} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 font-medium">
                            {n.title}
                            {!n.readAt && (
                              <span
                                className="size-2 rounded-full bg-brand-ink"
                                aria-label="Unread"
                                role="img"
                              />
                            )}
                          </span>
                          <span className="block text-[13px] text-muted">{n.body}</span>
                        </span>
                        <span className="shrink-0 text-[12px] text-muted">{ago(n.createdAt)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          }
        </Async>
      </Panel>
      {query.data && query.data.total > 0 && (
        <Pagination {...query.data} noun="notifications" onPage={setPage} />
      )}
    </PageBody>
  );
}
