import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.session.user) return true;
    throw new UnauthorizedException({
      code: 'AUTH_REQUIRED',
      message: 'Sign in to continue',
    });
  }
}
