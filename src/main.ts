import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { rateLimit } from 'express-rate-limit';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import session from 'express-session';
import { Server } from 'socket.io';
import { AppModule } from './app.module.js';
import { APP_VERSION } from './app-version.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { StockEventsService, inventoryEventRooms, inventorySubscriptionRooms } from './common/stock-events.service.js';
import { SESSION_COOKIE_NAME } from './auth/auth.controller.js';

const requestIdPattern = /^[a-zA-Z0-9._-]{8,64}$/;

type LogRequest = {
  id: unknown;
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
  session?: { user?: { id: string } };
};

type LogResponse = Pick<ServerResponse, 'getHeader' | 'statusCode'>;

function completionLogFields(request: LogRequest, response: LogResponse, sessionSecret: string) {
  const traceHeader = request.headers['x-trace-id'];
  const requestId = String(request.id);
  const errorCode = response.getHeader('X-Error-Code');
  const userId = request.session?.user?.id;
  const userIdHash = userId ? createHash('sha256').update(`${sessionSecret}:${userId}`).digest('hex') : undefined;

  return {
    timestamp: new Date().toISOString(),
    service: 'stocksync-api',
    environment: process.env.NODE_ENV ?? 'development',
    version: APP_VERSION,
    eventName: response.statusCode >= 400 ? 'api.request.failed' : 'api.request.completed',
    outcome: response.statusCode >= 400 ? 'failure' : 'success',
    traceId: typeof traceHeader === 'string' && requestIdPattern.test(traceHeader) ? traceHeader : requestId,
    httpMethod: request.method,
    routeTemplate: request.url?.split('?')[0]?.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') ?? '/',
    httpStatus: response.statusCode,
    errorCode: typeof errorCode === 'string' ? errorCode : undefined,
    userIdHash,
  };
}

export async function bootstrap(port = Number(process.env.PORT ?? 5402)): Promise<INestApplication> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('StockSync local-session mode is not configured for production deployment');
  }

  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });
  const localWebOrigins = ['http://127.0.0.1:5401', 'http://localhost:5401'];
  const webOrigin = process.env.WEB_ORIGIN ?? localWebOrigins[0];
  const allowedOrigins = new Set([webOrigin]);
  if (!process.env.WEB_ORIGIN || localWebOrigins.includes(webOrigin)) {
    localWebOrigins.forEach((origin) => allowedOrigins.add(origin));
  }
  const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
  const sessionMiddleware = session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 8 * 60 * 60 * 1000,
    },
  });

  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    const providedId = request.header('x-request-id');
    const requestId = providedId && requestIdPattern.test(providedId) ? providedId : randomUUID();
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-ID', requestId);
    next();
  });
  app.use(
    pinoHttp({
      logger: pino({
        level: process.env.LOG_LEVEL ?? 'info',
        timestamp: false,
        formatters: {
          level: (label) => ({ level: label.toUpperCase() }),
        },
        redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      }),
      genReqId: (request) => {
        const requestId = request.headers['x-request-id'];
        return typeof requestId === 'string' ? requestId : randomUUID();
      },
      quietReqLogger: true,
      customSuccessObject: (request, response, loggableObject) => ({
        ...loggableObject,
        ...completionLogFields(request, response, sessionSecret),
      }),
      customErrorObject: (request, response, error, loggableObject) => ({
        ...loggableObject,
        ...completionLogFields(request, response, sessionSecret),
        errorType: error.name,
      }),
      customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (response) => ({ statusCode: response.statusCode }),
      },
      customLogLevel: (_request, response, error) => {
        if (error || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(helmet());
  app.use(sessionMiddleware);
  app.use(
    '/api/v1/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use('/api/v1', (request: Request, response: Response, next: NextFunction) => {
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const requestOrigin = request.header('origin');
    if (!isMutation || (requestOrigin && allowedOrigins.has(requestOrigin))) return next();
    response.setHeader('X-Error-Code', 'ORIGIN_NOT_ALLOWED');
    response.status(403).json({
      code: 'ORIGIN_NOT_ALLOWED',
      message: 'Request origin is not allowed',
      requestId: response.getHeader('X-Request-ID'),
    });
  });
  app.enableCors({
    origin: [...allowedOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-ID', 'X-Trace-ID'],
    exposedHeaders: ['X-Request-ID'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.init();

  const socketServer = new Server(app.getHttpServer(), {
    path: '/socket.io',
    cors: { origin: [...allowedOrigins], credentials: true },
  });
  socketServer.engine.use(sessionMiddleware);
  socketServer.use((socket, next) => {
    const user = socket.request.session?.user;
    if (!user) return next(new Error('Authentication required'));

    const roomJoin = Promise.all(
      inventorySubscriptionRooms(user).map(async (room) => {
        await socket.join(room);
      }),
    );
    void roomJoin.then(
      () => next(),
      () => next(new Error('Inventory subscription unavailable')),
    );
  });
  app.get(StockEventsService).attachPublisher((event) => {
    socketServer.to(inventoryEventRooms(event.locationId)).emit('inventory.updated', event);
  });

  await app.listen(port, '127.0.0.1');
  return app;
}

if (process.env.STOCKSYNC_START_SERVER === 'true') await bootstrap();
