import { createBrowserRouter, Navigate, useRouteError } from 'react-router';
import { AdminLayout } from './layouts/admin.tsx';
import { AppLayout } from './layouts/app.tsx';
import { AdminAuthShell, AdminForgot, AdminLogin, AdminReset } from './pages/admin/auth.tsx';
import { AdminOperations } from './pages/admin/operations.tsx';
import { AdminOverviewPage } from './pages/admin/overview.tsx';
import { AdminPayIn, AdminPayIns } from './pages/admin/pay-ins.tsx';
import { AdminSalary, AdminSalaryDetail } from './pages/admin/salary.tsx';
import { AdminSettings } from './pages/admin/settings.tsx';
import { AdminUser, AdminUsers } from './pages/admin/users.tsx';
import { DashboardPage } from './pages/dashboard.tsx';
import { BeneficiaryPage, DestinationsPage, WalletPage } from './pages/destinations.tsx';
import { ForgotPassword, Login, Register, ResetPassword, VerifyEmail, Welcome } from './pages/auth.tsx';
import { Landing } from './pages/landing.tsx';
import { NotificationsPage } from './pages/notifications.tsx';
import { OnboardingPage } from './pages/onboarding.tsx';
import { RulesPage } from './pages/rules.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SplitPage } from './pages/splits.tsx';
import { TransactionsPage } from './pages/transactions.tsx';
import { buttonClass } from './ui/core.tsx';

function Crash() {
  const error = useRouteError();
  console.error(error);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-muted">
        Nothing was changed. Reload the page, and contact support if it keeps happening.
      </p>
      <a href="/" className={buttonClass()}>
        Reload PaySplit
      </a>
    </main>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <a href="/" className={buttonClass()}>
        Go to PaySplit
      </a>
    </main>
  );
}

export const router = createBrowserRouter([
  {
    errorElement: <Crash />,
    children: [
      {
        path: '/',
        element: <Landing />,
        children: [
          { path: 'login', element: <Login /> },
          { path: 'register', element: <Register /> },
          { path: 'verify-email', element: <VerifyEmail /> },
          { path: 'welcome', element: <Welcome /> },
          { path: 'forgot-password', element: <ForgotPassword /> },
          { path: 'reset-password', element: <ResetPassword /> },
        ],
      },
      {
        element: <AppLayout />,
        children: [
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'onboarding', element: <OnboardingPage /> },
          { path: 'transactions', element: <TransactionsPage /> },
          { path: 'destinations', element: <DestinationsPage /> },
          { path: 'destinations/wallets/:id', element: <WalletPage /> },
          { path: 'destinations/beneficiaries/:id', element: <BeneficiaryPage /> },
          { path: 'rules', element: <RulesPage /> },
          { path: 'splits/:id', element: <SplitPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
      {
        element: <AdminAuthShell />,
        children: [
          { path: 'admin/login', element: <AdminLogin /> },
          { path: 'admin/forgot-password', element: <AdminForgot /> },
          { path: 'admin/reset-password', element: <AdminReset /> },
        ],
      },
      {
        path: 'admin',
        element: <AdminLayout />,
        children: [
          { index: true, element: <AdminOverviewPage /> },
          { path: 'users', element: <AdminUsers /> },
          { path: 'users/:id', element: <AdminUser /> },
          { path: 'salary', element: <AdminSalary /> },
          { path: 'salary/:id', element: <AdminSalaryDetail /> },
          { path: 'pay-ins', element: <AdminPayIns /> },
          { path: 'pay-ins/:id', element: <AdminPayIn /> },
          { path: 'operations', element: <AdminOperations /> },
          { path: 'settings', element: <AdminSettings /> },
          { path: '*', element: <Navigate to="/admin" replace /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
