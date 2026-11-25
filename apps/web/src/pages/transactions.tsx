import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileText, ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@paysplit/core';
import { PageBody } from '../layouts/app.tsx';
import { download, get, query as qs } from '../lib/api.ts';
import { title, TYPE_TEXT } from '../lib/format.ts';
import type { Beneficiary, Page, Transaction, Wallet } from '../lib/types.ts';
import {
  Async,
  Button,
  EmptyState,
  FormError,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  Segmented,
  Select,
} from '../ui/core.tsx';
import { TransactionDrawer, TransactionTable } from '../ui/tables.tsx';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function StatementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1, 12)));
  const [to, setTo] = useState(iso(now));
  const [account, setAccount] = useState('salary');
  const [format, setFormat] = useState<'csv' | 'pdf'>('csv');
  const wallets = useQuery({
    queryKey: ['wallets'],
    queryFn: () => get<{ items: Wallet[] }>('/v1/wallets'),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: () => download(`/v1/statements${qs({ from, to, account, format })}`),
    onSuccess: onClose,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Account statement"
      subtitle="Totals come from your ledger and always reconcile"
      width="max-w-md"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="salary">Salary account</option>
          <option value="all">All accounts</option>
          {wallets.data?.items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} (wallet)
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="From"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
          <Input
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </div>
        <Segmented
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            ['csv', 'CSV'],
            ['pdf', 'PDF'],
          ]}
        />
        <FormError error={save.error} />
        <Button
          type="submit"
          className="w-full"
          busy={save.isPending}
          icon={<Download className="size-4" aria-hidden />}
        >
          Download {format.toUpperCase()}
        </Button>
      </form>
    </Modal>
  );
}

export function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const [exporting, setExporting] = useState(false);
  const read = (key: string) => params.get(key) ?? '';
  const patch = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries({ page: '', focus: '', ...changes }))
      value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  const page = Number(read('page')) || 1;
  const filters = {
    group: read('group'),
    type: read('type'),
    status: read('status'),
    walletId: read('walletId'),
    beneficiaryId: read('beneficiaryId'),
    from: read('from'),
    to: read('to'),
    q: read('q'),
  };
  const filtered = Object.values(filters).some(Boolean);
  const list = useQuery({
    queryKey: ['transactions', filters, page],
    queryFn: () => get<Page<Transaction>>(`/v1/transactions${qs({ ...filters, page, pageSize: 10 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const wallets = useQuery({ queryKey: ['wallets'], queryFn: () => get<{ items: Wallet[] }>('/v1/wallets') });
  const people = useQuery({
    queryKey: ['beneficiaries'],
    queryFn: () => get<{ items: Beneficiary[] }>('/v1/beneficiaries'),
  });
  const destination = filters.walletId
    ? `w:${filters.walletId}`
    : filters.beneficiaryId
      ? `b:${filters.beneficiaryId}`
      : '';

  return (
    <PageBody>
      <PageHeader
        title="Transactions"
        crumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Transactions' }]}
        actions={
          <Button onClick={() => setExporting(true)} icon={<FileText className="size-4" aria-hidden />}>
            Export Statement
          </Button>
        }
      />
      <Panel
        flush
        title="Transaction & Splits History"
        actions={
          <>
            <SearchInput
              value={filters.q}
              onChange={(q) => patch({ q })}
              label="Search description or reference"
            />
            <Segmented
              label="Show"
              value={filters.group as '' | 'wallet' | 'beneficiary'}
              onChange={(group) => patch({ group })}
              options={[
                ['', 'All'],
                ['wallet', 'Wallet'],
                ['beneficiary', 'Beneficiary'],
              ]}
            />
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 border-b p-4 lg:grid-cols-5">
          <Select label="Type" value={filters.type} onChange={(e) => patch({ type: e.target.value })}>
            <option value="">All types</option>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_TEXT[t]}
              </option>
            ))}
          </Select>
          <Select label="Status" value={filters.status} onChange={(e) => patch({ status: e.target.value })}>
            <option value="">All statuses</option>
            {TRANSACTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {title(s)}
              </option>
            ))}
          </Select>
          <Select
            label="Wallet or beneficiary"
            wrapClass="col-span-2 lg:col-span-1"
            value={destination}
            onChange={(e) =>
              patch({
                walletId: e.target.value.startsWith('w:') ? e.target.value.slice(2) : '',
                beneficiaryId: e.target.value.startsWith('b:') ? e.target.value.slice(2) : '',
              })
            }
          >
            <option value="">Any</option>
            <optgroup label="Wallets">
              {wallets.data?.items.map((w) => (
                <option key={w.id} value={`w:${w.id}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Beneficiaries">
              {people.data?.items.map((b) => (
                <option key={b.id} value={`b:${b.id}`}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          </Select>
          <Input
            label="From"
            type="date"
            value={filters.from}
            onChange={(e) => patch({ from: e.target.value })}
          />
          <Input label="To" type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} />
        </div>
        <Async query={list} rows={8}>
          {(data) =>
            data.total === 0 ? (
              filtered ? (
                <EmptyState
                  icon={<ReceiptText className="size-5" />}
                  title="No matching transactions"
                  action={
                    <Button variant="outline" size="sm" onClick={() => setParams({}, { replace: true })}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={<ReceiptText className="size-5" />} title="No transactions yet">
                  Salary, splits and transfers appear here with their status.
                </EmptyState>
              )
            ) : (
              <TransactionTable items={data.items} onOpen={(id) => patch({ open: id, page: String(page) })} />
            )
          }
        </Async>
      </Panel>
      {list.data && (
        <Pagination {...list.data} noun="activity entries" onPage={(p) => patch({ page: String(p) })} />
      )}
      <TransactionDrawer id={read('open') || null} onClose={() => patch({ open: '', page: String(page) })} />
      <StatementModal open={exporting} onClose={() => setExporting(false)} />
    </PageBody>
  );
}
