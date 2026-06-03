/**
 * Thin wrappers around Obsidian's sanctioned APIs.
 *
 * The plugin must NEVER touch node fs, child_process, or worker_threads —
 * mobile constraint + Obsidian review will reject. All HTTP goes through
 * requestUrl(); OAuth callbacks come through registerObsidianProtocolHandler.
 */

import {
  requestUrl as obsidianRequestUrl,
  RequestUrlParam,
  RequestUrlResponse,
  Plugin,
  ObsidianProtocolHandler,
} from 'obsidian';

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}

export async function obsidianFetch(opts: FetchOptions): Promise<RequestUrlResponse> {
  const params: RequestUrlParam = {
    url: opts.url,
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
    throw: opts.throw ?? false,
    contentType: opts.headers?.['Content-Type'] ?? undefined,
  };
  return obsidianRequestUrl(params);
}

export function registerProtocolHandler(
  plugin: Plugin,
  action: string,
  handler: ObsidianProtocolHandler,
): void {
  plugin.registerObsidianProtocolHandler(action, handler);
}
