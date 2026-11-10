import { SetMetadata } from '@nestjs/common';
import type { UserRole } from './auth.types.js';

export const ROLES_KEY = 'stocksync:roles';
export const RequireRoles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
