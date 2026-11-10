import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionGuard } from './session.guard.js';

export const SESSION_COOKIE_NAME = 'stocksync.sid';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Req() request: Request) {
    const user = await this.authService.authenticate(body);
    await this.regenerateSession(request);
    request.session.user = user;
    request.session.csrfToken = randomBytes(32).toString('base64url');
    return { user, csrfToken: request.session.csrfToken };
  }

  @Get('synthetic-roles')
  async listSyntheticRoles() {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException({
        code: 'SYNTHETIC_ROLE_DISCOVERY_DISABLED',
        message: 'Synthetic role discovery is unavailable',
      });
    }
    return this.authService.listSyntheticRoles();
  }

  @Get('session')
  getSession(@Req() request: Request) {
    return {
      user: request.session.user ?? null,
      csrfToken: request.session.csrfToken ?? null,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((error) => (error ? reject(error) : resolve()));
    });
    response.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: 'lax' });
    return { loggedOut: true };
  }

  private regenerateSession(request: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      request.session.regenerate((error) => (error ? reject(error) : resolve()));
    });
  }
}
