import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { CsrfGuard } from './csrf.guard.js';
import { RequireRoles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import { SessionGuard } from './session.guard.js';

class UnrestrictedController {
  handle() {}
}

@RequireRoles('inventory_manager')
class ManagerController {
  handle() {}
}

function context(request: object, controller = UnrestrictedController) {
  return new ExecutionContextHost([request], () => undefined, controller);
}

describe('StockSync authorization guards', () => {
  it('allows authenticated sessions and rejects anonymous requests', () => {
    const guard = new SessionGuard();
    const user = { id: 'manager-1', role: 'inventory_manager' };

    expect(guard.canActivate(context({ session: { user } }))).toBe(true);
    expect(() => guard.canActivate(context({ session: {} }))).toThrow(UnauthorizedException);
  });

  it('allows routes without role metadata and enforces declared manager roles', () => {
    const guard = new RolesGuard(new Reflector());
    const manager = { id: 'manager-1', role: 'inventory_manager' };
    const associate = { id: 'associate-1', role: 'associate' };

    expect(guard.canActivate(context({ session: {} }))).toBe(true);
    expect(guard.canActivate(context({ session: { user: manager } }, ManagerController))).toBe(true);
    expect(() => guard.canActivate(context({ session: {} }, ManagerController))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context({ session: { user: associate } }, ManagerController))).toThrow(
      ForbiddenException,
    );
  });

  it('requires a matching CSRF token for state-changing requests', () => {
    const guard = new CsrfGuard();

    expect(
      guard.canActivate(
        context({
          session: { csrfToken: 'csrf-token' },
          header: () => 'csrf-token',
        }),
      ),
    ).toBe(true);
    expect(() => guard.canActivate(context({ session: {}, header: () => 'csrf-token' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context({ session: { csrfToken: 'csrf-token' }, header: () => undefined }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(context({ session: { csrfToken: 'csrf-token' }, header: () => 'short' }))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      guard.canActivate(context({ session: { csrfToken: 'csrf-token' }, header: () => 'wrong-token' })),
    ).toThrow(ForbiddenException);
  });
});
