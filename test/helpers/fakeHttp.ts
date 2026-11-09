import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: unknown;
}

type Handler = (req: FakeRequest) => { status?: number; data?: unknown } | Promise<{ status?: number; data?: unknown }>;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
export const calls: FakeRequest[] = [];

export function on(method: string, pattern: RegExp, handler: Handler): void {
  routes.unshift({ method: method.toUpperCase(), pattern, handler });
}

export function resetFake(): void {
  routes.length = 0;
  calls.length = 0;
}

function fullUrl(config: InternalAxiosRequestConfig): string {
  const base = config.baseURL ?? '';
  const url = config.url ?? '';
  return /^https?:\/\//.test(url) ? url : `${base.replace(/\/$/, '')}${url.startsWith('/') || !url ? '' : '/'}${url}`;
}

export const fakeAdapter: AxiosAdapter = async (config) => {
  const method = (config.method ?? 'get').toUpperCase();
  const url = fullUrl(config);
  let body: unknown = config.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // keep raw
    }
  }
  const req: FakeRequest = { method, url, headers: { ...(config.headers ?? {}) }, body };
  calls.push(req);
  const route = routes.find((r) => r.method === method && r.pattern.test(url));
  if (!route) {
    const response = { status: 599, statusText: 'no fake route', data: { error: `no fake route for ${method} ${url}` }, headers: {}, config };
    throw new AxiosError(`no fake route for ${method} ${url}`, 'ERR_FAKE', config, null, response);
  }
  const out = await route.handler(req);
  const status = out.status ?? 200;
  const response = { status, statusText: String(status), data: out.data ?? {}, headers: {}, config };
  if (status >= 400) {
    throw new AxiosError(`fake ${status}`, String(status), config, null, response);
  }
  return response;
};
