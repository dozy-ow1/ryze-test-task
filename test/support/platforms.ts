import type { AddressInfo } from 'node:net';
import { FAULT_KINDS, type FaultKind } from '@ryze/core';
import { expect } from 'vitest';
import { type AppOptions, buildApp } from '../../packages/fake-platforms/src/app.js';

type FastifyInstance = ReturnType<typeof buildApp>;

export const WP = '/wordpress/wp/v2';
export const SHOP = '/shopify/admin/api/2026-10';
export const HOST = 'fake-platforms:8092';
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

export interface Inspect {
  sites: {
    token: string;
    platform: string;
    faults: { rate: number; kinds: FaultKind[] };
    faults_injected: Record<FaultKind, number>;
    media: { id: string; filename: string }[];
    posts: {
      id: string;
      slug: string;
      status: 'draft' | 'live';
      article_id: string | null;
      media_id: string | null;
      url: string | null;
    }[];
  }[];
}

// Every app built by makeApp(); test files close them with afterEach(closeApps).
const apps: FastifyInstance[] = [];

export async function closeApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((app) => app.close()));
}

export function makeApp(options: Partial<AppOptions> = {}): FastifyInstance {
  const app = buildApp({ faultRate: 0, faultKinds: [...FAULT_KINDS], ...options });
  apps.push(app);
  return app;
}

export async function registerSite(
  app: FastifyInstance,
  token: string,
  platform: 'wordpress' | 'shopify',
  faults?: { rate?: number; kinds?: FaultKind[] },
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/_admin/sites',
    payload: { token, platform, faults },
  });
  expect(res.statusCode).toBe(201);
}

export async function inspect(app: FastifyInstance): Promise<Inspect> {
  return (await app.inject({ url: '/_admin/inspect' })).json();
}

// A real socket, for the faults that inject() cannot show (dropped and held connections).
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
