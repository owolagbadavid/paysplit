import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Download,
  Share2,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { download, get } from '../lib/api.ts';
import { date, dateTime, money, naira, title, TYPE_TEXT } from '../lib/format.ts';
import type { Transaction, TransactionDetail } from '../lib/types.ts';
import { Async, Badge, Button, cx, Modal, Notice, Rows, Status, useToast } from './core.tsx';

type Side = 'salary' | 'wallet';

/** Whether money arrived, seen from the salary account or from a wallet. */
const isIn = (t: Transaction, side: Side) =>
  side === 'wallet'
    ? t.type === 'wallet_allocation'
    : t.type === 'salary_received' || t.type === 'wallet_to_salary';

function Direction({ t }: { t: Transaction }) {
  const [Icon, style] =
    t.type === 'salary_received'
      ? [ArrowDownLeft, 'bg-good-soft text-good']
      : t.type === 'beneficiary_transfer'
        ? [ArrowUpRight, 'bg-bad-soft text-bad']
        : t.type === 'wallet_to_salary'
          ? [ArrowDownLeft, 'bg-brand-soft text-brand-ink']
          : [WalletIcon, 'bg-brand-soft text-brand-ink'];
  return (
    <span
      className={cx('inline-flex size-6 shrink-0 items-center justify-center rounded-md', style as string)}
      aria-hidden
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function Amount({ t, side }: { t: Transaction; side: Side }) {
  const settled = t.status === 'success';
  const color = !settled
    ? 'text-muted'
    : t.type === 'salary_received'
      ? 'text-good'
      : t.type === 'beneficiary_transfer'
        ? 'text-bad'
        : 'text-brand-ink';
  return (
    <span
      className={cx(
        'num font-medium whitespace-nowrap',
        color,
        (t.status === 'failed' || t.status === 'reversed') && 'line-through',
      )}
    >
      {isIn(t, side) ? '+' : '-'}
      {naira(t.amount)}
    </span>
  );
}

/** Table on wide screens, list on narrow ones. Every row opens the transaction. */
export function TransactionTable({
  items,
  onOpen,
  showReference = true,
  side = 'salary',
}: {
  items: Transaction[];
  onOpen?: (id: string) => void;
  showReference?: boolean;
  side?: Side;
}) {
  return (
    <>
      <table className="hidden w-full text-left text-[13px] md:table">
        <thead className="text-muted">
          <tr className="border-b">
            {showReference && <th className="px-4 py-3 font-normal">Reference</th>}
            <th className="px-4 py-3 font-normal">Description</th>
            <th className="px-4 py-3 font-normal">Category</th>
            <th className="px-4 py-3 font-normal">Date</th>
            <th className="px-4 py-3 font-normal">Status</th>
            <th className="px-4 py-3 text-right font-normal">Amount</th>
            {onOpen && (
              <th className="w-10">
                <span className="sr-only">Open</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((t) => (
            <tr key={t.id} className="hover:bg-brand-wash">
              {showReference && <td className="num px-4 py-3 whitespace-nowrap">{t.reference}</td>}
              <td className="px-4 py-3">
                <span className="flex items-center gap-2">
                  <Direction t={t} />
                  <span className="max-w-64 truncate">{t.description}</span>
                </span>
              </td>
              <td className="px-4 py-3">
                <span className="rounded-md border px-2 py-0.5">{title(t.category)}</span>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                {showReference ? dateTime(t.createdAt) : date(t.createdAt)}
              </td>
              <td className="px-4 py-3">
                <Status value={t.status} />
              </td>
              <td className="px-4 py-3 text-right">
                <Amount t={t} side={side} />
              </td>
              {onOpen && (
                <td className="pr-2">
                  <button
                    type="button"
                    aria-label={`Open ${t.reference}`}
                    onClick={() => onOpen(t.id)}
                    className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-white"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y md:hidden">
        {items.map((t) => {
          const body = (
            <>
              <Direction t={t} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.description}</span>
                <span className="block text-[12px] text-muted">{dateTime(t.createdAt)}</span>
              </span>
              <span className="text-right">
                <span className="block">
                  <Amount t={t} side={side} />
                </span>
                <Status value={t.status} />
              </span>
            </>
          );
          return (
            <li key={t.id}>
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(t.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-4 py-3">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const PENDING_TEXT: Record<string, string> = {
  pending:
    'The bank has not confirmed this yet. The money is held safely and will either arrive or come back to your salary account.',
  retrying: 'The last attempt did not go through. We are trying again, and your money is held until it does.',
};

export function TransactionDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const query = useQuery({
    queryKey: ['transactions', 'detail', id],
    queryFn: () => get<TransactionDetail>(`/v1/transactions/${id}`),
    enabled: Boolean(id),
  });
  const receipt = useMutation({
    mutationFn: () => download(`/v1/transactions/${id}/receipt`),
    onError: (e) => toast((e as Error).message, 'bad'),
  });
  return (
    <Modal open={Boolean(id)} onClose={onClose} title="Transaction Details" side="right" width="max-w-md">
      <Async query={query} rows={5}>
        {(t) => (
          <>
            <div className="rounded-xl border bg-brand-wash py-5 text-center">
              <p className="text-[13px] text-muted">{TYPE_TEXT[t.type]}</p>
              <p className="num my-1 text-[28px] font-bold tracking-tight">{naira(t.amount)}</p>
              <Status value={t.status} />
            </div>
            {PENDING_TEXT[t.status] && (
              <div className="mt-3">
                <Notice>{PENDING_TEXT[t.status]}</Notice>
              </div>
            )}
            {(t.status === 'failed' || t.status === 'reversed') && (
              <div className="mt-3">
                <Notice
                  tone="bad"
                  title={t.status === 'failed' ? 'This transfer failed' : 'This transfer was reversed'}
                >
                  {t.failureReason}. The money is back in your salary account. Check the account details, then
                  use Run Now.
                </Notice>
              </div>
            )}
            <div className="mt-2">
              <Rows
                items={[
                  ['From', [t.source.label, t.source.detail].filter(Boolean).join(', ')],
                  ['To', [t.destination.label, t.destination.detail].filter(Boolean).join(', ')],
                  ['Category', title(t.category)],
                  ['Date', dateTime(t.createdAt)],
                  ...(t.completedAt && t.completedAt !== t.createdAt
                    ? ([['Completed', dateTime(t.completedAt)]] as [string, string][])
                    : []),
                  ['Fee', t.fee ? money(t.fee) : 'Free'],
                  ['Reference', t.reference],
                  ...(t.providerReference
                    ? ([['Provider reference', <span className="break-all">{t.providerReference}</span>]] as [
                        string,
                        React.ReactNode,
                      ][])
                    : []),
                  ...(t.rule
                    ? ([['Split rule', `${t.rule.name}${t.rule.deleted ? ' (deleted)' : ''}`]] as [
                        string,
                        string,
                      ][])
                    : []),
                  ...(t.execution
                    ? ([
                        [
                          'Split',
                          <Link to={`/splits/${t.execution.id}`} className="text-brand-ink hover:underline">
                            {t.execution.reference}
                          </Link>,
                        ],
                      ] as [string, React.ReactNode][])
                    : []),
                ]}
              />
            </div>
            {t.isTest && (
              <p className="mt-3">
                <Badge>Test mode: no real money moved</Badge>
              </p>
            )}
            {t.hasReceipt && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  icon={<Share2 className="size-4" aria-hidden />}
                  onClick={() => share(t).then((how) => how === 'copied' && toast('Receipt details copied'))}
                >
                  Share
                </Button>
                <Button
                  icon={<Download className="size-4" aria-hidden />}
                  busy={receipt.isPending}
                  onClick={() => receipt.mutate()}
                >
                  Receipt
                </Button>
              </div>
            )}
          </>
        )}
      </Async>
    </Modal>
  );
}

async function share(t: TransactionDetail): Promise<'shared' | 'copied' | 'cancelled'> {
  const text = `PaySplit receipt\n${TYPE_TEXT[t.type]}: ${money(t.amount)}\nTo: ${t.destination.label}\nReference: ${t.reference}\n${dateTime(t.completedAt ?? t.createdAt)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'PaySplit receipt', text });
      return 'shared';
    }
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'cancelled';
  }
}
