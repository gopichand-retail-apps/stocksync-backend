import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';
import type { SessionUser, UserRole } from './auth.types.js';
import type { AuthService } from './auth.service.js';
import type { Request, Response } from 'express';

const user: SessionUser = {
  id: 'manager-1',
  email: 'manager@stocksync.test',
  displayName: 'Morgan Patel',
  role: 'inventory_manager',
  homeLocationId: 'loc-central',
};

type TestSession = {
  regenerate(callback: (error?: Error | null) => void): void;
  destroy(callback: (error?: Error | null) => void): void;
};

function requestWithSession(session: TestSession): Request {
  return { session } as unknown as Request;
}

describe('AuthController session failures', () => {
  const authService = {
    authenticate: async () => user,
    listSyntheticRoles: async (): Promise<UserRole[]> => ['inventory_manager'],
  } as unknown as AuthService;

  it('does not create a login response when session regeneration fails', async () => {
    const error = new Error('session storage unavailable');
    const session = {
      regenerate: (callback: (error?: Error | null) => void) => callback(error),
      destroy: (callback: (error?: Error | null) => void) => callback(),
    };
    const request = requestWithSession(session);
    const controller = new AuthController(authService);

    await expect(controller.login({ email: user.email, password: 'synthetic-only' }, request)).rejects.toBe(error);
    expect(request.session.user).toBeUndefined();
    expect(request.session.csrfToken).toBeUndefined();
  });

  it('does not clear a cookie when session destruction fails', async () => {
    const error = new Error('session store unavailable');
    const session = {
      regenerate: (callback: (error?: Error | null) => void) => callback(),
      destroy: (callback: (error?: Error | null) => void) => callback(error),
    };
    const request = requestWithSession(session);
    const clearCookie = vi.fn();
    const response = { clearCookie } as unknown as Response;
    const controller = new AuthController(authService);

    await expect(controller.logout(request, response)).rejects.toBe(error);
    expect(clearCookie).not.toHaveBeenCalled();
  });
});
