import { Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import type { SessionUser, UserRole } from './auth.types.js';

const dummyHash = hash('not-a-valid-demo-password');

const LoginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();

interface UserRecord extends Record<string, unknown> {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  home_location_id: string;
  is_active: boolean;
}

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  async listSyntheticRoles(): Promise<UserRole[]> {
    const result = await this.database.query<{ role: UserRole }>(
      `SELECT DISTINCT role FROM users WHERE is_active = TRUE ORDER BY role`,
    );
    return result.rows.map(({ role }) => role);
  }

  async authenticate(input: unknown): Promise<SessionUser> {
    const credentials = LoginSchema.safeParse(input);
    if (!credentials.success) throw this.invalidCredentials();

    const result = await this.database.query<UserRecord>(
      `SELECT id, email, display_name, role, password_hash, home_location_id, is_active
       FROM users WHERE email = $1`,
      [credentials.data.email],
    );
    const record = result.rows[0];
    const storedHash = record?.password_hash ?? (await dummyHash);
    const validPassword = await verify(storedHash, credentials.data.password);
    if (!record || !record.is_active || !validPassword) throw this.invalidCredentials();

    return {
      id: record.id,
      email: record.email,
      displayName: record.display_name,
      role: record.role,
      homeLocationId: record.home_location_id,
    };
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect',
    });
  }
}
