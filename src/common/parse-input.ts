import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export function parseInput<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new BadRequestException({
    code: 'INVALID_INPUT',
    message: 'Request validation failed',
    details: result.error.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
    })),
  });
}
