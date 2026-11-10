import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from './auth.types.js';

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => {
  const request = context.switchToHttp().getRequest<Request>();
  const user = request.session.user;
  if (user) return user;
  throw new UnauthorizedException({ code: 'AUTH_REQUIRED', message: 'Sign in to continue' });
});
