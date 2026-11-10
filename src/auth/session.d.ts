import type { SessionUser } from './auth.types.js';
import type { Session, SessionData } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    csrfToken?: string;
  }
}

declare module 'http' {
  interface IncomingMessage {
    session: Session & Partial<SessionData>;
  }
}
