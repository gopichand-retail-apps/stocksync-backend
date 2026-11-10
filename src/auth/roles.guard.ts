import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from './roles.decorator.js';
import type { UserRole } from './auth.types.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (request.session.user && roles.includes(request.session.user.role)) return true;
    throw new ForbiddenException({
      code: 'ROLE_REQUIRED',
      message: 'Your role cannot perform this action',
    });
  }
}
