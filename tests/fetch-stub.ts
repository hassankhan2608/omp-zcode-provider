/**
 * Test seam for injecting a fake transport.
 *
 * Bun's `typeof fetch` carries a `preconnect` member that a plain handler
 * function cannot satisfy, and every injection point in this extension only
 * ever calls the function itself. One documented double cast here keeps that
 * assertion out of every individual test.
 */
export type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function asFetch(handler: FetchHandler): typeof fetch {
  return handler as unknown as typeof fetch;
}
