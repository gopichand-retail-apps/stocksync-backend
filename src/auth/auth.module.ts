import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { RolesGuard } from './roles.guard.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, CsrfGuard, RolesGuard, SessionGuard],
  exports: [CsrfGuard, RolesGuard, SessionGuard],
})
export class AuthModule {}
