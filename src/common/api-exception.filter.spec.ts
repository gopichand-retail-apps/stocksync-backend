import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from './api-exception.filter.js';

function applyFilter(exception: unknown, responseRequestId?: string, requestId?: string) {
  const response = {
    getHeader: vi.fn((name: string) => (name === 'X-Request-ID' ? responseRequestId : undefined)),
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue({ json: response.json });
  const request = { header: vi.fn(() => requestId) };
  const host = new ExecutionContextHost([request, response]);

  new ApiExceptionFilter().catch(exception, host);
  return { request, response };
}

describe('ApiExceptionFilter', () => {
  it('preserves stable client error codes, details, and the response request ID', () => {
    const { response } = applyFilter(
      new BadRequestException({
        code: 'INVALID_STOCK',
        message: 'Stock input is invalid',
        details: { field: 'quantity' },
      }),
      'response-request-1',
      'request-header-1',
    );

    expect(response.setHeader).toHaveBeenCalledWith('X-Error-Code', 'INVALID_STOCK');
    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith({
      code: 'INVALID_STOCK',
      message: 'Stock input is invalid',
      details: { field: 'quantity' },
      requestId: 'response-request-1',
    });
  });

  it('uses string exception messages and the request header when no response ID exists', () => {
    const { request, response } = applyFilter(
      new HttpException('The operation was rejected', HttpStatus.CONFLICT),
      undefined,
      'request-header-2',
    );

    expect(response.json).toHaveBeenCalledWith({
      code: 'REQUEST_REJECTED',
      message: 'The operation was rejected',
      requestId: 'request-header-2',
    });
    expect(request.header).toHaveBeenCalledWith('x-request-id');
  });

  it('hides unexpected exception details and uses a null request ID when none is available', () => {
    const { request, response } = applyFilter(new Error('database connection string'));

    expect(response.setHeader).toHaveBeenCalledWith('X-Error-Code', 'INTERNAL_ERROR');
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: null,
    });
    expect(request.header).toHaveBeenCalledWith('x-request-id');
    expect(JSON.stringify(response.json.mock.calls[0])).not.toContain('database connection string');
  });

  it('falls back to a generic public message for structured errors without a string message', () => {
    const { response } = applyFilter(new HttpException({ message: ['invalid'] }, HttpStatus.BAD_REQUEST));

    expect(response.json).toHaveBeenCalledWith({
      code: 'REQUEST_REJECTED',
      message: 'Request could not be completed',
      requestId: null,
    });
  });
});
