import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health(): { status: 'ok'; service: 'stocksync-api' } {
    return this.appService.getHealth();
  }

  @Get('version')
  @Header('Cache-Control', 'no-store')
  version(): { service: 'stocksync-api'; version: string } {
    return this.appService.getVersion();
  }
}
