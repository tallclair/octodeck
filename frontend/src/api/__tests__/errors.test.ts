import { describe, it, expect } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { ExprErrorSchema, Field } from '../octodeck/v1/query_pb';
import { exprErrorOf, isConnectivityError, isInvalidArgument, retryUnlessInvalid } from '../errors';

const invalid = () =>
  new ConnectError('invalid query', Code.InvalidArgument, undefined, [
    { desc: ExprErrorSchema, value: create(ExprErrorSchema, { path: 'and.exprs[1].predicate.values[0]', message: 'unknown value "x"', field: Field.STATE, value: 'x' }) },
  ]);

describe('api errors', () => {
  it('classifies InvalidArgument as an invalid query, not a connectivity problem', () => {
    expect(isInvalidArgument(invalid())).toBe(true);
    expect(isConnectivityError(invalid())).toBe(false);
  });

  it('treats any other error as a connectivity problem', () => {
    expect(isConnectivityError(new ConnectError('down', Code.Unavailable))).toBe(true);
    expect(isConnectivityError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectivityError(null)).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
  });

  it('extracts the ExprError detail', () => {
    expect(exprErrorOf(invalid())).toEqual({ message: 'unknown value "x"', path: 'and.exprs[1].predicate.values[0]' });
  });

  it('falls back to the error message without a detail, and ignores other errors', () => {
    expect(exprErrorOf(new ConnectError('bad facet field', Code.InvalidArgument))).toEqual({ message: 'bad facet field', path: '' });
    expect(exprErrorOf(new ConnectError('down', Code.Unavailable))).toBeNull();
  });

  it('retries transient errors up to three times but never an invalid query', () => {
    expect(retryUnlessInvalid(0, new ConnectError('down', Code.Unavailable))).toBe(true);
    expect(retryUnlessInvalid(3, new ConnectError('down', Code.Unavailable))).toBe(false);
    expect(retryUnlessInvalid(0, invalid())).toBe(false);
  });
});
