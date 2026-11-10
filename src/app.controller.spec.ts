import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('returns the StockSync API health contract', () => {
      expect(appController.health()).toEqual({ status: 'ok', service: 'stocksync-api' });
    });
  });

  describe('version', () => {
    it('returns the backend package version', () => {
      expect(appController.version()).toEqual({
        service: 'stocksync-api',
        version: '1.0.0',
      });
    });
  });
});
