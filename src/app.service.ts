import { Injectable } from '@nestjs/common';
import { APP_VERSION } from './app-version.js';

@Injectable()
export class AppService {
  getHealth(): { status: 'ok'; service: 'stocksync-api' } {
    return { status: 'ok', service: 'stocksync-api' };
  }

  getVersion(): { service: 'stocksync-api'; version: string } {
    return { service: 'stocksync-api', version: APP_VERSION };
  }
}
