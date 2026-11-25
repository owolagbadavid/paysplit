import { ArrowRight, Bell, Landmark, PiggyBank, ShieldCheck, Split } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { useSession } from '../lib/session.ts';
import { buttonClass, cx, Logo, Wordmark } from '../ui/core.tsx';

const FEATURES = [
  {
    icon: Landmark,
    title: 'One account for your salary',
    text: 'Get a dedicated account number to give your employer. Your salary lands in PaySplit.',
  },
  {
    icon: Split,
    title: 'Rules you set once',
    text: 'Fixed amounts or percentages, in the order you choose. Nothing runs until your salary is confirmed.',
  },
  {
    icon: PiggyBank,
    title: 'Savings that happen',
    text: 'Money moves to your wallets and the people you support the moment you are paid.',
  },
  {
    icon: ShieldCheck,
    title: 'Every naira accounted for',
    text: 'Each movement is on record, with receipts and statements you can download.',
  },
];

function LaptopPreview() {
  return (
    <div
      aria-hidden
      className="relative mx-auto w-full max-w-[620px] lg:translate-x-6 lg:[transform:perspective(1600px)_rotateY(-14deg)_rotateX(4deg)]"
    >
      <div className="overflow-hidden rounded-xl border-[6px] border-[#1b2129] bg-white shadow-[0_40px_120px_rgb(40_120_200/28%)]">
        <div className="flex items-center justify-between px-4 py-2 text-[10px] text-ink">
          <span className="flex items-center gap-1 font-semibold">
            <Logo className="size-4" /> Paysplit
          </span>
          <span className="flex gap-3 text-muted">
            <span className="font-semibold text-ink">Dashboard</span>
            <span>Transactions</span>
            <span>Destination</span>
            <span>Split Rules</span>
          </span>
          <Bell className="size-3" />
        </div>
        <div className="hero flex h-32 items-end p-4 text-lg text-white">Good afternoon, Paul!</div>
        <div className="grid grid-cols-4 gap-2 p-3 text-[9px] text-ink">
          <div>
            <p className="text-muted">Salary Account Balance</p>
            <p className="mt-1 text-base font-bold">₦850,000</p>
          </div>
          {[
            ['Split Allocation', '₦612,500'],
            ['Total in Wallets', '₦1,610,000'],
            ['Expected Next Split', '25 Nov'],
          ].map(([k, v]) => (
            <div key={k} className="tile p-2">
              <p className="text-muted">{k}</p>
              <p className="mt-1.5 text-[11px] font-semibold">{v}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[1fr_140px] gap-2 px-3 pb-4">
          <div className="flex h-28 items-end gap-3 rounded-lg border p-3">
            {[46, 30, 58, 40, 84, 36, 52].map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-t"
                style={{ height: `${h}%`, background: i === 4 ? '#57a4ef' : '#e6f2fe' }}
              />
            ))}
          </div>
          <div className="flex items-center justify-center rounded-lg border">
            <div className="size-20 rounded-full border-8 border-brand border-r-ink" />
          </div>
        </div>
      </div>
      <div className="mx-auto h-3 w-[112%] -translate-x-[5.5%] rounded-b-2xl bg-linear-to-b from-[#3a434f] to-[#10151b]" />
    </div>
  );
}

/** Marketing page. Sign-in and sign-up open as dialogs over it, as in the design. */
export function Landing() {
  const { pathname } = useLocation();
  const { data } = useSession();
  const signedIn = Boolean(data?.user);
  const dialogOpen = pathname !== '/';
  return (
    <div className="min-h-dvh bg-[#04070c] text-white">
      <div className={cx('transition-[filter]', dialogOpen && 'blur-sm')}>
        <div className="hero flex min-h-dvh flex-col">
          <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-5">
            <Wordmark />
            <nav aria-label="Main" className="hidden gap-7 text-[14px] text-white/85 md:flex">
              <a href="#how" className="hover:text-white">
                About PaySplit
              </a>
              <a href="/docs" className="hover:text-white">
                API
              </a>
            </nav>
            <div className="flex items-center gap-2">
              {signedIn ? (
                <Link to="/dashboard" className={buttonClass()}>
                  Open dashboard <ArrowRight className="size-4" aria-hidden />
                </Link>
              ) : (
                <>
                  <Link
                    to="/login"
                    className="flex h-11 items-center gap-1.5 rounded-field px-3 text-[14px] hover:bg-white/10"
                  >
                    Login <ArrowRight className="size-4" aria-hidden />
                  </Link>
                  <Link to="/register" className={buttonClass()}>
                    Get Started <ArrowRight className="hidden size-4 sm:block" aria-hidden />
                  </Link>
                </>
              )}
            </div>
          </header>
          <main className="mx-auto grid w-full max-w-7xl flex-1 items-center gap-10 px-5 pb-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <h1 className="max-w-xl text-[40px] leading-[1.06] font-normal tracking-[-0.03em] sm:text-[60px]">
                We automate salary partitions that ignite financial clarity.
              </h1>
              <p className="mt-5 max-w-md text-[16px] text-white/75">
                Set your rules once. When your salary lands, PaySplit moves it to your savings, your bills and
                your people.
              </p>
              <Link
                to={signedIn ? '/dashboard' : '/register'}
                className={cx(buttonClass('primary', 'lg'), 'mt-8')}
              >
                {signedIn ? 'Open dashboard' : 'Create your account'}{' '}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
            <LaptopPreview />
          </main>
        </div>
        <section id="how" className="bg-canvas py-20 text-ink">
          <div className="mx-auto max-w-7xl px-5">
            <h2 className="text-[30px] tracking-tight">How PaySplit works</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map(({ icon: Icon, title, text }) => (
                <div key={title} className="tile p-5">
                  <Icon className="size-6 text-brand-ink" aria-hidden />
                  <h3 className="mt-5 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-[13px] text-[#3a4450]">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
        <footer className="bg-canvas pb-10 text-ink">
          <div className="mx-auto flex max-w-7xl flex-wrap justify-between gap-3 border-t px-5 pt-6 text-[13px] text-muted">
            <span>PaySplit {new Date().getFullYear()}. Test environment: no real money moves.</span>
            <Link to="/admin/login" className="hover:underline">
              Administrators
            </Link>
          </div>
        </footer>
      </div>
      <div className="text-ink">
        <Outlet />
      </div>
    </div>
  );
}
