export type UserRole = 'associate' | 'inventory_manager' | 'auditor';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  homeLocationId: string;
}
