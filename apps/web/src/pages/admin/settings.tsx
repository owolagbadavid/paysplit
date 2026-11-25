import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, queryClient } from '../../lib/api.ts';
import { date } from '../../lib/format.ts';
import { useAdminSession } from '../../lib/session.ts';
import type { Admin } from '../../lib/types.ts';
import {
  Avatar,
  Button,
  fieldErrors,
  FormError,
  Input,
  PageHeader,
  Panel,
  useToast,
} from '../../ui/core.tsx';
import { ChangePasswordForm } from '../settings.tsx';

export function AdminSettings() {
  const admin = useAdminSession().data!.admin!;
  const toast = useToast();
  const [form, setForm] = useState({
    firstName: admin.firstName,
    lastName: admin.lastName,
    phone: admin.phone ?? '',
  });
  const save = useMutation({
    mutationFn: () => api<Admin>('PATCH', '/v1/admin/me', { ...form, phone: form.phone || null }),
    onSuccess: (next) => {
      queryClient.setQueryData(['admin-session'], { admin: next });
      toast('Profile saved');
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <>
      <PageHeader title="Setting" crumbs={[{ label: 'Dashboard', to: '/admin' }, { label: 'Setting' }]} />
      <div className="grid items-start gap-4 lg:grid-cols-[320px_1fr]">
        <div className="tile rounded-card border p-5">
          <div className="flex items-center gap-3">
            <Avatar name={`${admin.firstName} ${admin.lastName}`} className="size-14 text-lg" />
            <div>
              <p className="text-[17px] font-semibold">
                {admin.firstName} {admin.lastName}
              </p>
              <p className="text-[13px] text-muted">Administrator</p>
            </div>
          </div>
          <dl className="mt-5 space-y-2 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{admin.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Created</dt>
              <dd>{date(admin.createdAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="space-y-4">
          <Panel title="Personal details">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="First name"
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  error={errors.firstName}
                  required
                />
                <Input
                  label="Last name"
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  error={errors.lastName}
                  required
                />
                <Input label="Email address" value={admin.email} disabled />
                <Input
                  label="Phone Number"
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  error={errors.phone}
                />
              </div>
              <FormError error={save.error} />
              <Button type="submit" busy={save.isPending}>
                Save changes
              </Button>
            </form>
          </Panel>
          <Panel title="Security">
            <ChangePasswordForm
              path="/v1/admin/me/change-password"
              changedAt={admin.passwordChangedAt}
              onDone={() => void queryClient.invalidateQueries({ queryKey: ['admin-session'] })}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}
