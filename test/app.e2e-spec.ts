import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import session from 'express-session';
import request from 'supertest';
import { SESSION_COOKIE_NAME } from './../src/auth/auth.controller.js';
import { AppModule } from './../src/app.module.js';
import { ApiExceptionFilter } from './../src/common/api-exception.filter.js';
import { DatabaseService } from './../src/database/database.service.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let originalDataDirectory: string | undefined;
  let originalNodeEnvironment: string | undefined;

  beforeAll(() => {
    originalDataDirectory = process.env.STOCKSYNC_DATA_DIR;
    originalNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    delete process.env.STOCKSYNC_DATA_DIR;
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(
      session({
        name: SESSION_COOKIE_NAME,
        secret: 'stocksync-e2e-only-session-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax', secure: false },
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  it('/api/v1/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect({ status: 'ok', service: 'stocksync-api' });
  });

  it('rejects anonymous inventory reads and returns the stable error envelope', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/inventory')
      .set('X-Request-ID', 'anonymous-request-01')
      .expect(401)
      .expect('X-Error-Code', 'AUTH_REQUIRED')
      .expect({
        code: 'AUTH_REQUIRED',
        message: 'Sign in to continue',
        requestId: 'anonymous-request-01',
      });
  });

  it('lists only local synthetic role codes without creating an authenticated session', async () => {
    const agent = request.agent(app.getHttpServer());
    const response = await agent.get('/api/v1/auth/synthetic-roles').expect(200);

    expect(response.body).toEqual(['associate', 'auditor', 'inventory_manager']);
    expect(JSON.stringify(response.body)).not.toMatch(/@|email|password|hash/i);
    await agent.get('/api/v1/auth/session').expect(200, { user: null, csrfToken: null });
  });

  it('hides synthetic role discovery in production mode', async () => {
    const originalEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await request(app.getHttpServer())
        .get('/api/v1/auth/synthetic-roles')
        .expect(404)
        .expect(({ body }) => {
          expect(body.code).toBe('SYNTHETIC_ROLE_DISCOVERY_DISABLED');
        });
    } finally {
      if (originalEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnvironment;
    }
  });

  it('authenticates seeded roles, persists a session, and allows an authorized receipt', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'manager@stocksync.test', password: 'stock-demo-only' })
      .expect(200);
    expect(login.body.user).toMatchObject({ role: 'inventory_manager', homeLocationId: 'loc-central' });
    expect(login.body.csrfToken).toEqual(expect.any(String));

    await agent.get('/api/v1/auth/session').expect(200, {
      user: login.body.user,
      csrfToken: login.body.csrfToken,
    });
    const inventory = await agent.get('/api/v1/inventory?locationId=loc-central').expect(200);
    const coffee = inventory.body.find((item: { skuId: string }) => item.skuId === 'sku-coffee');
    expect(coffee).toBeDefined();

    await agent
      .post('/api/v1/receipts')
      .set('X-CSRF-Token', login.body.csrfToken)
      .set('Idempotency-Key', 'e2e-receipt-manager-0001')
      .send({ locationId: 'loc-central', skuId: 'sku-coffee', quantity: 1 })
      .expect(201);
  });

  it('serves the inventory views and completes the manager stock workflows', async () => {
    const manager = request.agent(app.getHttpServer());
    const login = await manager
      .post('/api/v1/auth/login')
      .send({ email: 'manager@stocksync.test', password: 'stock-demo-only' })
      .expect(200);
    const csrfValue: unknown = login.body.csrfToken;
    if (typeof csrfValue !== 'string') throw new Error('Manager login did not return a CSRF token');
    const csrf = csrfValue;
    const idempotency = (key: string) => `${key}-e2e-0001`;

    await manager.get('/api/v1/locations').expect(200);
    await manager.get('/api/v1/inventory/categories').expect(200);
    await manager.get('/api/v1/overview?locationId=loc-central').expect(200);
    await manager.get('/api/v1/ledger?locationId=loc-central&limit=10').expect(200);
    await manager.get('/api/v1/transfers').expect(200);
    await manager.get('/api/v1/reservations?locationId=loc-central').expect(200);

    const transfer = await manager
      .post('/api/v1/transfers')
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', idempotency('e2e-transfer-create'))
      .send({
        fromLocationId: 'loc-central',
        toLocationId: 'loc-north',
        skuId: 'sku-coffee',
        quantity: 1,
      })
      .expect(201);
    await manager
      .patch(`/api/v1/transfers/${transfer.body.id}/receive`)
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', idempotency('e2e-transfer-receive'))
      .expect(200);

    const inventory = await manager.get('/api/v1/inventory?locationId=loc-central').expect(200);
    const coffee = inventory.body.find((item: { skuId: string }) => item.skuId === 'sku-coffee');
    expect(coffee).toBeDefined();
    await manager
      .post('/api/v1/cycle-counts')
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', idempotency('e2e-cycle-count'))
      .send({
        locationId: 'loc-central',
        skuId: 'sku-coffee',
        expectedVersion: coffee.version,
        countedQuantity: coffee.onHand,
      })
      .expect(201);
    await manager
      .post('/api/v1/adjustments')
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', idempotency('e2e-adjustment'))
      .send({ locationId: 'loc-central', skuId: 'sku-coffee', delta: 1, note: 'audit adjustment' })
      .expect(201);
    const reservation = await manager
      .post('/api/v1/reservations')
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', idempotency('e2e-reservation'))
      .send({ locationId: 'loc-central', skuId: 'sku-coffee', quantity: 1 })
      .expect(201);
    await manager
      .patch(`/api/v1/reservations/${reservation.body.id}/release`)
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', idempotency('e2e-release'))
      .expect(200);

    await manager.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf).expect(200, { loggedOut: true });
    await manager.get('/api/v1/auth/session').expect(200, { user: null, csrfToken: null });
  });

  it('denies an associate another location and denies auditor mutations', async () => {
    const associate = request.agent(app.getHttpServer());
    const associateLogin = await associate
      .post('/api/v1/auth/login')
      .send({ email: 'associate@stocksync.test', password: 'stock-demo-only' })
      .expect(200);
    await associate
      .get('/api/v1/locations')
      .expect(200, [{ id: 'loc-central', code: 'CTR-01', name: 'Central Market', region: 'Bay Area' }]);
    await associate.get('/api/v1/transfers').expect(200);
    await associate.get('/api/v1/inventory?locationId=loc-central').expect(200);
    await associate.get('/api/v1/inventory?locationId=loc-north').expect(403);
    await associate
      .post('/api/v1/receipts')
      .set('X-CSRF-Token', associateLogin.body.csrfToken)
      .set('Idempotency-Key', 'e2e-receipt-associate-0001')
      .send({ locationId: 'loc-north', skuId: 'sku-coffee', quantity: 1 })
      .expect(404);

    const auditor = request.agent(app.getHttpServer());
    const auditorLogin = await auditor
      .post('/api/v1/auth/login')
      .send({ email: 'auditor@stocksync.test', password: 'stock-demo-only' })
      .expect(200);
    await auditor
      .post('/api/v1/receipts')
      .set('X-CSRF-Token', auditorLogin.body.csrfToken)
      .set('Idempotency-Key', 'e2e-receipt-auditor-0001')
      .send({ locationId: 'loc-central', skuId: 'sku-coffee', quantity: 1 })
      .expect(403);
  });

  it('rejects missing CSRF tokens and malformed strict DTOs', async () => {
    const manager = request.agent(app.getHttpServer());
    const login = await manager
      .post('/api/v1/auth/login')
      .send({ email: 'manager@stocksync.test', password: 'stock-demo-only' })
      .expect(200);
    const payload = { locationId: 'loc-central', skuId: 'sku-coffee', quantity: 1 };

    await manager.post('/api/v1/receipts').set('Idempotency-Key', 'e2e-receipt-no-csrf-0001').send(payload).expect(403);
    await manager
      .post('/api/v1/receipts')
      .set('X-CSRF-Token', 'invalid')
      .set('Idempotency-Key', 'e2e-receipt-wrong-csrf-0001')
      .send(payload)
      .expect(403);
    const wrongCsrf = login.body.csrfToken.slice(0, -1) + (login.body.csrfToken.endsWith('x') ? 'y' : 'x');
    await manager
      .post('/api/v1/receipts')
      .set('X-CSRF-Token', wrongCsrf)
      .set('Idempotency-Key', 'e2e-receipt-same-length-csrf-01')
      .send(payload)
      .expect(403);
    await manager
      .post('/api/v1/receipts')
      .set('X-CSRF-Token', login.body.csrfToken)
      .set('Idempotency-Key', 'e2e-receipt-invalid-0001')
      .send({ ...payload, type: 'receive' })
      .expect(400);
    await manager.get(`/api/v1/reservations?locationId=${'x'.repeat(81)}`).expect(400);
  });

  it('returns the same safe login error for unknown and incorrect credentials', async () => {
    const unknownAccount = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'unknown@stocksync.test', password: 'wrong-password' })
      .expect(401);
    const wrongPassword = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'manager@stocksync.test', password: 'wrong-password' })
      .expect(401);

    expect(unknownAccount.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknownAccount.body.message).toBe(wrongPassword.body.message);
  });

  it('rejects malformed credentials and inactive synthetic accounts', async () => {
    await app.get(DatabaseService).query('UPDATE users SET is_active = FALSE WHERE id = $1', ['user-auditor']);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Request-ID', 'malformed-login-0001')
      .send({ email: 'not-an-email', password: '' })
      .expect(401)
      .expect(({ body }) => {
        expect(body).toEqual({
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect',
          requestId: expect.any(String),
        });
      });
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'auditor@stocksync.test', password: 'stock-demo-only' })
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe('INVALID_CREDENTIALS');
      });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    if (originalDataDirectory === undefined) {
      delete process.env.STOCKSYNC_DATA_DIR;
    } else {
      process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
    }
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });
});
