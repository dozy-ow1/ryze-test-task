import { execFileSync, execSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createDemoStack } from './demo-stack.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(() => '') }));

describe('demo isolation', () => {
  it('removes real credentials and shared resources before starting any services', () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        name: 'ryze',
        services: {
          worker: {
            build: { args: { PKG: 'worker' } },
            image: 'ryze-worker',
            environment: {
              LLM_PROVIDER: 'anthropic',
              IMAGE_PROVIDER: 'openai',
              ANTHROPIC_API_KEY: 'real-key',
            },
            env_file: '.env',
            ports: [{ host_ip: '0.0.0.0', published: '8080', target: 8080 }],
          },
        },
        volumes: { pgdata: { name: 'ryze_pgdata' } },
        networks: { default: { name: 'ryze_default' } },
      }),
    );
    createDemoStack().command('docker compose up -d');
    const options = vi.mocked(execSync).mock.calls[0][1] as { input: string };
    const config = JSON.parse(options.input);
    expect(config.services.worker.environment).toMatchObject({
      LLM_PROVIDER: 'fake',
      IMAGE_PROVIDER: 'fake',
      DATABASE_URL: 'postgres://ryze:ryze@postgres:5432/ryze',
    });
    expect(options.input).not.toContain('real-key');
    expect(options.input).not.toContain('ryze_pgdata');
    expect(options.input).not.toContain('ryze_default');
    expect(config.services.worker.image).toMatch(/^ryze-demo-[a-f0-9]+-worker$/);
    expect(config.services.worker.image).not.toBe('ryze-worker');
    expect(config.name).toBeUndefined();
    expect(config.services.worker.env_file).toBeUndefined();
    expect(config.services.worker.ports[0]).toMatchObject({ host_ip: '127.0.0.1', published: '0' });
  });
});
