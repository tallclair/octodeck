// Classifies daemon RPC errors. An invalid query (InvalidArgument) is a problem with the
// request, not with the connection, so it must not show the "Disconnected" state.
import { Code, ConnectError } from '@connectrpc/connect';
import { ExprErrorSchema } from './octodeck/v1/query_pb';

export function isInvalidArgument(err: unknown): boolean {
  return err instanceof ConnectError && err.code === Code.InvalidArgument;
}

/** Whether a query error means the daemon is unreachable or failing (anything but a bad query). */
export function isConnectivityError(err: unknown): boolean {
  return err != null && !isInvalidArgument(err);
}

export interface InvalidQueryInfo {
  /** Human-readable reason. */
  readonly message: string;
  /** Path to the offending node in the Expr ('' for the root). */
  readonly path: string;
}

/** The structured ExprError carried by an InvalidArgument error, or null for other errors. */
export function exprErrorOf(err: unknown): InvalidQueryInfo | null {
  if (!(err instanceof ConnectError) || err.code !== Code.InvalidArgument) return null;
  const [detail] = err.findDetails(ExprErrorSchema);
  return { message: detail?.message || err.rawMessage, path: detail?.path ?? '' };
}

/** Query retry policy: an invalid query fails the same way every time, so it is not retried. */
export function retryUnlessInvalid(failureCount: number, err: unknown): boolean {
  return !isInvalidArgument(err) && failureCount < 3;
}
