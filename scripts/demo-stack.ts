import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Render a disposable project from the checked-in Compose file. All runtime settings and secrets
// are replaced before it can start; neither .env nor the normal project's volumes are used.
interface ComposeConfig {
  name?: string;
  services: Record<
    string,
    {
      build?: { args?: { PKG?: string } };
      image?: string;
      environment?: Record<string, string>;
      env_file?: unknown;
      ports?: { host_ip: string; published: string }[];
    }
  >;
  volumes?: Record<string, { name?: string }>;
  networks?: Record<string, { name?: string }>;
}

export function createDemoStack() {
  const root = resolve('.');
  const project = `ryze-demo-${randomBytes(6).toString('hex')}`;
  const example = resolve('.env.example');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  const source = readFileSync('docker-compose.yml', 'utf8').replaceAll(
    'env_file: .env',
    `env_file: ${JSON.stringify(example)}`,
  );

  const prefix = [
    'compose',
    '--project-directory',
    root,
    '--project-name',
    project,
    '--env-file',
    example,
  ];

  const config = JSON.parse(
    execFileSync('docker', [...prefix, '-f', '-', 'config', '--format', 'json'], {
      input: source,
      encoding: 'utf8',
    }),
  ) as ComposeConfig;

  const environment = {
    DATABASE_URL: 'postgres://ryze:ryze@postgres:5432/ryze',
    SITE_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    S3_ENDPOINT: 'http://minio:9000',
    S3_BUCKET: 'ryze',
    S3_ACCESS_KEY: 'ryze',
    S3_SECRET_KEY: 'ryze-demo-secret',
    LLM_PROVIDER: 'mock',
    IMAGE_PROVIDER: 'mock',
    LLM_BASE_URL: 'http://mock-providers:8091',
    IMAGE_BASE_URL: 'http://mock-providers:8091',
    MOCK_WORDPRESS_URL: 'http://mock-wordpress:8092',
    LOG_LEVEL: 'info',
    MINIO_ROOT_USER: 'ryze',
    MINIO_ROOT_PASSWORD: 'ryze-demo-secret',
    POSTGRES_USER: 'ryze',
    POSTGRES_PASSWORD: 'ryze',
    POSTGRES_DB: 'ryze',
  };

  const images = new Set<string>();

  for (const [name, service] of Object.entries(config.services)) {
    if (service.build) {
      service.image = `${project}-${service.build.args?.PKG ?? name}`;
      images.add(service.image);
    }

    const port = service.environment?.PORT;
    service.environment = { ...environment, ...(port === undefined ? {} : { PORT: port }) };
    delete service.env_file;

    for (const port of service.ports ?? []) {
      port.host_ip = '127.0.0.1';
      port.published = '0';
    }
  }

  // `compose config` expands resource names using its source project; let the isolated project
  // derive its own names instead of accidentally reusing volumes or networks.
  delete config.name;

  for (const resources of [config.volumes, config.networks]) {
    for (const resource of Object.values(resources ?? {})) {
      delete resource.name;
    }
  }

  const input = JSON.stringify(config);
  const args = [...prefix, '-f', '-'];

  const command = (cmd: string) =>
    execSync(cmd.replace(/^docker compose\b/, `docker ${args.map(quote).join(' ')}`), {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'inherit'],
    }).trim();

  return {
    command,

    endpoint(service: string, port: number) {
      return `http://${command(`docker compose port ${service} ${port}`).split('\n')[0]}`;
    },

    cleanup() {
      command('docker compose down --volumes --remove-orphans');

      if (images.size > 0) {
        try {
          execFileSync('docker', ['image', 'rm', ...images], { stdio: 'ignore' });
        } catch {
          // A failed build may never have created every tag; containers and data are already gone.
        }
      }
    },
  };
}
