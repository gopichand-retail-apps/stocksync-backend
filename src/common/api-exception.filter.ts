import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const details = typeof payload === 'object' && payload !== null ? payload : {};
    const error = 'code' in details && typeof details.code === 'string' ? details.code : undefined;
    const message = this.publicMessage(status, payload, details);
    const code = error ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED');
    response.setHeader('X-Error-Code', code);

    response.status(status).json({
      code,
      message,
      ...(details && typeof details === 'object' && 'details' in details ? { details: details.details } : {}),
      requestId: response.getHeader('X-Request-ID') ?? request.header('x-request-id') ?? null,
    });
  }

  private publicMessage(status: number, payload: unknown, details: object): string {
    if (status >= 500) return 'An unexpected error occurred';
    if (typeof payload === 'string') return payload;
    if ('message' in details && typeof details.message === 'string') return details.message;
    return 'Request could not be completed';
  }
}
