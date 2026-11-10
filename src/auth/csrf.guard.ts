import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = request.session.csrfToken;
    const submitted = request.header('x-csrf-token');

    if (!expected || !submitted || expected.length !== submitted.length) {
      throw this.invalidToken();
    }
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return true;
    throw this.invalidToken();
  }

  private invalidToken(): ForbiddenException {
    return new ForbiddenException({
      code: 'CSRF_INVALID',
      message: 'Refresh your session before trying again',
    });
  }
}
