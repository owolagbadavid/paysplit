import { useQuery } from '@tanstack/react-query';
import { get, queryClient } from './api.ts';
import type { Admin, User } from './types.ts';

export const useSession = () =>
  useQuery({
    queryKey: ['session'],
    queryFn: () => get<{ user: User | null }>('/v1/auth/session'),
    staleTime: 30_000,
  });
export const useAdminSession = () =>
  useQuery({
    queryKey: ['admin-session'],
    queryFn: () => get<{ admin: Admin | null }>('/v1/admin/auth/session'),
    staleTime: 30_000,
  });

/** The signed-in person. Only used below the signed-in layout, which guarantees there is one. */
export function useUser(): User {
  const { data } = useSession();
  return data!.user!;
}

export const setUser = (user: User) => queryClient.setQueryData(['session'], { user });
export const refreshSession = () => queryClient.invalidateQueries({ queryKey: ['session'] });
