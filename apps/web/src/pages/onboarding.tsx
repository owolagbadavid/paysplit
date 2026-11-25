import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, Check, ChevronLeft, ChevronRight, Globe, IdCard, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { COUNTRIES, country as countryOf, profileSchema } from '@paysplit/core';
import { PageBody } from '../layouts/app.tsx';
import { api, get, queryClient } from '../lib/api.ts';
import { refreshSession, setUser, useUser } from '../lib/session.ts';
import type { Kyc, User } from '../lib/types.ts';
import {
  Async,
  Button,
  buttonClass,
  cx,
  fieldErrors,
  FormError,
  Input,
  Modal,
  Notice,
  PageHeader,
  RadioCards,
  Segmented,
  Select,
} from '../ui/core.tsx';
import { Burst, zodErrors } from './auth.tsx';

type Step = 'profile' | 'identity' | 'liveness';
const STEPS: [Step, string][] = [
  ['profile', 'Profile Basics'],
  ['identity', 'Identity Verification'],
  ['liveness', 'Biometrics Liveness'],
];

function Stepper({ current, done }: { current: Step; done: Set<Step> }) {
  return (
    <aside className="tile flex flex-col items-center px-6 py-8 text-center">
      <span className="flex size-20 items-center justify-center rounded-2xl bg-white shadow-sm" aria-hidden>
        <IdCard className="size-9 text-brand-ink" />
      </span>
      <ol className="mt-10 space-y-5">
        {STEPS.map(([key, label]) => (
          <li
            key={key}
            aria-current={key === current ? 'step' : undefined}
            className="flex flex-col items-center gap-1.5"
          >
            <span
              className={cx(
                'flex size-6 items-center justify-center rounded-full border',
                done.has(key)
                  ? 'border-ink bg-ink text-white'
                  : key === current
                    ? 'border-brand bg-brand text-on-brand'
                    : 'border-field-line text-field-line',
              )}
              aria-hidden
            >
              <Check className="size-3.5" />
            </span>
            <span
              className={cx('text-[15px]', key === current ? 'font-semibold text-brand-ink' : 'text-muted')}
            >
              {label}
              {done.has(key) && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-auto max-w-52 pt-10 text-[13px] font-medium">
        We’ll use this information for verification and messages about your account.
      </p>
    </aside>
  );
}

function ProfileStep({ onDone }: { onDone: () => void }) {
  const user = useUser();
  const [country, setCountry] = useState(user.country ?? 'NG');
  const dial = countryOf(country)?.dialCode ?? '';
  const [phone, setPhone] = useState(
    user.phone && user.country === country ? user.phone.replace(dial, '') : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api<User>('PUT', '/v1/me/profile', { country, phone: `${dial}${phone.replace(/^0+/, '')}` }),
    onSuccess: async (next) => {
      setUser(next);
      await queryClient.invalidateQueries({ queryKey: ['kyc'] });
      onDone();
    },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const check = profileSchema.safeParse({ country, phone: `${dial}${phone.replace(/^0+/, '')}` });
        setErrors(zodErrors(check));
        if (check.success) save.mutate();
      }}
    >
      <Heading title="Profile Basics" text="Select your country and the phone number we can reach you on." />
      <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)} required>
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </Select>
      <div className="grid grid-cols-[110px_1fr] items-start gap-3">
        <Input label="Code" value={dial} readOnly tabIndex={-1} className="bg-strip text-muted" />
        <Input
          label="Mobile Phone Number"
          type="tel"
          autoComplete="tel-national"
          placeholder="803 456 7890"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone ?? fieldErrors(save.error).phone}
          required
        />
      </div>
      <FormError error={save.error} />
      <Button type="submit" className="w-full" busy={save.isPending}>
        Continue
      </Button>
    </form>
  );
}

const Heading = ({ title, text }: { title: string; text: string }) => (
  <div className="mb-2">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="text-[13px] text-muted">{text}</p>
  </div>
);

function IdentityStep({ kyc, onDone }: { kyc: Kyc; onDone: () => void }) {
  const config = countryOf(kyc.country);
  const [type, setType] = useState<'bvn' | 'nin'>(kyc.identityOptions[0]?.name ?? 'bvn');
  const [number, setNumber] = useState('');
  const verify = useMutation({
    mutationFn: () => api<Kyc>('POST', '/v1/kyc/identity', { type, number }),
    onSuccess: async (next) => {
      queryClient.setQueryData(['kyc'], next);
      await refreshSession();
      onDone();
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['kyc'] });
      void refreshSession();
    },
  });
  if (kyc.step === 'unsupported') {
    return (
      <div className="space-y-4">
        <Heading title="Identity verification" text={`Your country is ${config?.name ?? 'not set'}.`} />
        <Notice title="Not available in your country yet">
          PaySplit verifies people in Nigeria today. You can still set up wallets, beneficiaries and draft
          rules, and we will email you when verification opens.
        </Notice>
        <Link to="/dashboard" className={cx(buttonClass('outline'), 'w-full')}>
          Go to dashboard
        </Link>
      </div>
    );
  }
  const name = type.toUpperCase();
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      <Heading
        title="Select Verification Region"
        text="Provide the government identification for your country."
      />
      <RadioCards
        label="Region"
        value="ng"
        onChange={() => {}}
        options={[
          {
            value: 'ng',
            title: 'Nigeria Identity',
            detail: 'BVN or NIN',
            icon: <IdCard className="size-4" />,
          },
          {
            value: 'intl',
            title: 'International ID',
            detail: 'Not open yet',
            icon: <Globe className="size-4" />,
            disabled: true,
          },
        ]}
      />
      <div>
        <p className="mb-1.5 text-[13px] font-medium">Select Identity Verification Method *</p>
        <Segmented
          label="Identity type"
          value={type}
          onChange={(value) => {
            setType(value);
            setNumber('');
            verify.reset();
          }}
          options={kyc.identityOptions.map((o) => [o.name, o.label] as const)}
        />
      </div>
      <Input
        label={`${name} number`}
        inputMode="numeric"
        autoComplete="off"
        maxLength={11}
        placeholder="e.g. 22234918239"
        value={number}
        onChange={(e) => {
          setNumber(e.target.value.replace(/\D/g, ''));
          verify.reset();
        }}
        error={verify.error ? (verify.error as Error).message : undefined}
        hint={`Dial ${type === 'bvn' ? '*565*0#' : '*346#'} on your registered mobile number to check your ${name}. It is sent securely to our verification provider and erased once you are verified. We keep only the last four digits.`}
        required
      />
      <Button type="submit" className="w-full" disabled={number.length !== 11} busy={verify.isPending}>
        Verify {name}
      </Button>
    </form>
  );
}

const MAX_EDGE = 720;

/** Takes one still from the camera, cropped square and scaled down before it leaves the device. */
function capture(video: HTMLVideoElement): string {
  const size = Math.min(video.videoWidth, video.videoHeight);
  const edge = Math.min(MAX_EDGE, size);
  const canvas = Object.assign(document.createElement('canvas'), { width: edge, height: edge });
  canvas
    .getContext('2d')!
    .drawImage(
      video,
      (video.videoWidth - size) / 2,
      (video.videoHeight - size) / 2,
      size,
      size,
      0,
      0,
      edge,
      edge,
    );
  return canvas.toDataURL('image/jpeg', 0.88);
}

function LivenessStep({
  kyc,
  onDone,
  onRestart,
}: {
  kyc: Kyc;
  onDone: (status: string) => void;
  onRestart: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<'idle' | 'starting' | 'live' | 'denied' | 'missing'>('idle');
  const [photo, setPhoto] = useState<string | null>(null);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = async () => {
    setPhoto(null);
    check.reset();
    setCamera('starting');
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 } },
        audio: false,
      });
      setCamera('live');
      requestAnimationFrame(() => {
        if (video.current && stream.current) {
          video.current.srcObject = stream.current;
          void video.current.play();
        }
      });
    } catch (error) {
      setCamera((error as DOMException).name === 'NotAllowedError' ? 'denied' : 'missing');
    }
  };

  const check = useMutation({
    mutationFn: (image: string) => api<Kyc>('POST', '/v1/kyc/liveness', { image }),
    onSuccess: async (next) => {
      queryClient.setQueryData(['kyc'], next);
      await refreshSession();
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onDone(next.status);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['kyc'] });
      void refreshSession();
    },
  });

  const take = () => {
    if (!video.current?.videoWidth) return;
    const image = capture(video.current);
    stop();
    setCamera('idle');
    setPhoto(image);
    check.mutate(image);
  };

  const spent = kyc.attemptsLeft === 0 || kyc.step !== 'liveness';
  return (
    <div className="space-y-4">
      <Heading
        title="Biometric Liveness Verification"
        text="Find good light and look straight at the camera. Remove hats and glasses, and make sure only you are in the frame."
      />
      <div className="flex items-center justify-center rounded-xl bg-strip p-6">
        <div
          className={cx(
            'relative flex size-56 items-center justify-center overflow-hidden rounded-full border-2 bg-[#e6ebf1]',
            camera === 'live' ? 'border-good' : 'border-line-strong',
          )}
        >
          {camera === 'live' && (
            <video
              ref={video}
              playsInline
              muted
              className="size-full -scale-x-100 object-cover"
              aria-label="Camera preview"
            />
          )}
          {camera !== 'live' && photo && (
            <img src={photo} alt="Your photo" className="size-full -scale-x-100 object-cover" />
          )}
          {camera !== 'live' && !photo && <Camera className="size-10 text-muted" aria-hidden />}
        </div>
      </div>
      <p className="text-center text-[13px] font-medium" role="status">
        {check.isPending
          ? 'Checking with our verification provider…'
          : camera === 'live'
            ? 'Position your face inside the circle'
            : camera === 'starting'
              ? 'Allow camera access when your browser asks'
              : 'Your photo is checked and never stored by PaySplit'}
      </p>
      {camera === 'denied' && (
        <Notice tone="warn" title="Camera access is off">
          Allow the camera for this site in your browser settings, then try again.
        </Notice>
      )}
      {camera === 'missing' && (
        <Notice tone="warn" title="No camera found">
          Open PaySplit on a phone or a computer with a camera to finish this step. Your progress is saved.
        </Notice>
      )}
      {Boolean(check.error) && (
        <Notice tone="bad" title="That did not work">
          {(check.error as Error).message}{' '}
          {spent ? '' : `${kyc.attemptsLeft} ${kyc.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`}
        </Notice>
      )}
      {spent && check.error ? (
        <Button className="w-full" onClick={onRestart}>
          Start again with BVN or NIN
        </Button>
      ) : camera === 'live' ? (
        <Button className="w-full" onClick={take} icon={<Camera className="size-4" aria-hidden />}>
          Take shot
        </Button>
      ) : (
        <Button
          className="w-full"
          onClick={() => void start()}
          busy={check.isPending || camera === 'starting'}
          icon={
            photo ? <RefreshCw className="size-4" aria-hidden /> : <Camera className="size-4" aria-hidden />
          }
        >
          {photo ? 'Try again' : 'Open camera'}
        </Button>
      )}
    </div>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const kyc = useQuery({
    queryKey: ['kyc'],
    queryFn: () => get<Kyc>('/v1/kyc'),
    refetchInterval: (q) => (q.state.data?.step === 'review' ? 15_000 : false),
  });
  const [override, setOverride] = useState<Step | null>(null);
  const [approved, setApproved] = useState(false);

  return (
    <PageBody>
      <PageHeader
        title="Complete KYC"
        crumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Onboarding' }]}
      />
      <Async query={kyc} rows={6}>
        {(state) => {
          if (state.step === 'done' && !approved) {
            return (
              <div className="mx-auto max-w-md rounded-card border bg-white p-6">
                <Burst />
                <p className="text-center text-lg font-semibold">You are verified</p>
                <p className="mt-1 text-center text-[13px] text-muted">
                  Your identity and liveness checks are complete.
                </p>
                <Link to="/dashboard" className={cx(buttonClass(), 'mt-5 w-full')}>
                  Go to dashboard
                </Link>
              </div>
            );
          }
          if (state.step === 'review')
            return (
              <Notice title="Your verification is being reviewed">
                We will notify you when there is a decision. Until then you can set up wallets, beneficiaries
                and rules.{' '}
                <Link to="/dashboard?setup=1" className="underline">
                  Continue to Setup Checklist
                </Link>
              </Notice>
            );
          const required: Step =
            state.step === 'profile'
              ? 'profile'
              : state.step === 'liveness' || state.step === 'done'
                ? 'liveness'
                : 'identity';
          const order = STEPS.map(([key]) => key);
          const step = override && order.indexOf(override) <= order.indexOf(required) ? override : required;
          const done = new Set(order.slice(0, order.indexOf(required)));
          const previous = order[order.indexOf(step) - 1];
          return (
            <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
              <Stepper current={step} done={done} />
              <div className="rounded-card border bg-strip p-1.5">
                <div className="flex items-center justify-between px-3 py-2 text-[13px]">
                  <button
                    type="button"
                    disabled={!previous}
                    onClick={() => setOverride(previous ?? null)}
                    className="flex min-h-6 items-center gap-1 disabled:text-muted"
                  >
                    <ChevronLeft className="size-4" aria-hidden /> Previous
                  </button>
                  <Link
                    to="/dashboard"
                    className="flex min-h-6 items-center gap-1 text-brand-ink hover:underline"
                  >
                    Skip for now <ChevronRight className="size-4" aria-hidden />
                  </Link>
                </div>
                <div className="rounded-xl border bg-white px-5 py-8 sm:px-12">
                  <div className="mx-auto max-w-xl">
                    {['action_required', 'rejected', 'reverification_required'].includes(state.status) &&
                      state.reason &&
                      step === 'identity' && (
                        <div className="mb-5">
                          <Notice tone="warn" title="Action required">
                            {state.reason}
                          </Notice>
                        </div>
                      )}
                    {step === 'profile' && <ProfileStep onDone={() => setOverride(null)} />}
                    {step === 'identity' && <IdentityStep kyc={state} onDone={() => setOverride(null)} />}
                    {step === 'liveness' && (
                      <LivenessStep
                        kyc={state}
                        onDone={(status) => setApproved(status === 'approved')}
                        onRestart={() => setOverride('identity')}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        }}
      </Async>
      <Modal
        open={approved}
        onClose={() => navigate('/dashboard')}
        title="Identity Approved"
        hideTitle
        width="max-w-sm"
      >
        <Burst />
        <p className="text-center text-lg font-semibold">Identity Approved</p>
        <p className="mt-1 text-center text-[13px] text-muted">
          Your identity and liveness checks were confirmed by the provider. Your salary account is being set
          up.
        </p>
        <Link to="/dashboard?setup=1" className={cx(buttonClass(), 'mt-5 w-full')}>
          Continue to Setup Checklist
        </Link>
      </Modal>
    </PageBody>
  );
}
