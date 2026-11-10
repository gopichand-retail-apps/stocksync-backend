import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrap } from './main.js';
import { AppService } from './app.service.js';

describe('StockSync server bootstrap', () => {
  let app: INestApplication;
  let originalDataDirectory: string | undefined;
  let originalWebOrigin: string | undefined;
  let originalSessionSecret: string | undefined;
  let originalNodeEnvironment: string | undefined;

  beforeAll(async () => {
    originalDataDirectory = process.env.STOCKSYNC_DATA_DIR;
    originalWebOrigin = process.env.WEB_ORIGIN;
    originalSessionSecret = process.env.SESSION_SECRET;
    originalNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    delete process.env.STOCKSYNC_DATA_DIR;
    process.env.WEB_ORIGIN = 'http://127.0.0.1:5401';
    delete process.env.SESSION_SECRET;
    app = await bootstrap(0);
  });

  afterAll(async () => {
    await app.close();
    if (originalDataDirectory === undefined) delete process.env.STOCKSYNC_DATA_DIR;
    else process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
    if (originalWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = originalWebOrigin;
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('starts on an ephemeral loopback port and correlates health responses', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-ID', 'health-request-0001')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('health-request-0001');
    expect(response.body).toEqual({ status: 'ok', service: 'stocksync-api' });
  });

  it('uses valid trace IDs and authenticated request context in completion logs', async () => {
    const manager = request.agent(app.getHttpServer());
    await manager
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5401')
      .send({ email: 'manager@stocksync.test', password: 'stock-demo-only' })
      .expect(200);

    const response = await manager.get('/api/v1/health?readiness=1').set('X-Trace-ID', 'trace-id-0001').expect(200);

    expect(response.body).toEqual({ status: 'ok', service: 'stocksync-api' });
  });

  it('sanitizes unexpected API failures and normalizes UUIDs in request paths', async () => {
    const getHealth = vi.spyOn(app.get(AppService), 'getHealth').mockImplementation(() => {
      throw new Error('private diagnostic detail');
    });

    try {
      const failed = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-ID', 'health-error-0001')
        .expect(500);
      expect(failed.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'health-error-0001',
      });

      await request(app.getHttpServer())
        .get('/api/v1/transfers/682163f7-b8d3-4e18-8944-df558e3e9ab2')
        .set('X-Trace-ID', 'invalid trace')
        .expect(404);
    } finally {
      getHealth.mockRestore();
    }
  });

  it('uses PORT and safe in-memory defaults when bootstrap has no explicit port', async () => {
    const originalPort = process.env.PORT;
    const originalDataDirectory = process.env.STOCKSYNC_DATA_DIR;
    const originalNodeEnvironment = process.env.NODE_ENV;
    process.env.PORT = '0';
    process.env.STOCKSYNC_DATA_DIR = 'memory://';
    delete process.env.NODE_ENV;
    let defaultApp: INestApplication | undefined;

    try {
      defaultApp = await bootstrap();
      const response = await request(defaultApp.getHttpServer()).get('/api/v1/health').expect(200);
      expect(response.body).toEqual({ status: 'ok', service: 'stocksync-api' });
    } finally {
      if (defaultApp) await defaultApp.close();
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
      if (originalDataDirectory === undefined) delete process.env.STOCKSYNC_DATA_DIR;
      else process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
      if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnvironment;
    }
  });

  it('rejects originless and untrusted state-changing requests while allowing local origin aliases', async () => {
    const credentials = { email: 'unknown@stocksync.test', password: 'wrong-password' };
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', 'http://example.invalid')
      .send(credentials)
      .expect(403)
      .expect('X-Error-Code', 'ORIGIN_NOT_ALLOWED');

    for (const origin of ['http://localhost:5401', 'http://127.0.0.1:5401']) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send(credentials)
        .expect(401);
      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('refuses production mode until production session controls are configured', async () => {
    const originalEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(bootstrap(0)).rejects.toThrow(
        'StockSync local-session mode is not configured for production deployment',
      );
    } finally {
      if (originalEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnvironment;
    }
  });
});
