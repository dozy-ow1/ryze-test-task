// The acceptance run. 300 articles over two sites whose platforms fail 15 % of writes, providers
// failing 15 % of paid calls, two kill -9 rounds of the workers; then every article must be live
// exactly once, with its image, and every extra provider charge must be explained.
//
//   pnpm demo              (E2E=1 pnpm test runs the same with 50 articles and no kills)
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { POOL_LIMITS } from '../packages/worker/src/settings.js';
import { createDemoStack } from './demo-stack.js';
import { ALL_FAULTS, brief, call, registerMockSite } from './lib.js';

const SERVICES = [
  'postgres',
  'minio',
  'mock-providers',
  'mock-wordpress',
  'api',
  'worker-generate',
  'worker-publish',
];

const GENERATE_CONCURRENCY = POOL_LIMITS.generate.concurrency;
const STEPS = ['verify', 'text', 'image_submit', 'image_fetch', 'upload', 'draft', 'publish'];

type Summary = {
  operations: Record<string, Record<string, number>>;
  articles: { total: number; published: number };
};
type Counters = {
  text_calls: number;
  image_jobs: number;
  spend_usd: number;
  faults: Record<'text' | 'image_submit', Record<string, number>>;
};
type Inspect = {
  sites: {
    token: string;
    media: { id: string; filename: string }[];
    posts: {
      id: string;
      slug: string;
      status: string;
      article_id: string | null;
      media_id: string | null;
      url: string | null;
    }[];
  }[];
};

const sh = (cmd: string) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const restarts = (id: string) => Number(sh(`docker inspect -f '{{.RestartCount}}' ${id}`));

// SIGKILL the worker process inside the container: it dies like a crash and Compose restarts the
// container (`docker kill` would count as a manual stop and leave it down).
async function kill(service: string, command = sh): Promise<{ id: string; before: number }> {
  for (let tries = 0; ; tries++) {
    const id = command(`docker compose ps -q ${service}`).split('\n')[0];

    try {
      const before = restarts(id);
      sh(`docker exec ${id} sh -c 'kill -9 $(pidof node)'`);

      return { id, before };
    } catch (err) {
      if (tries === 5) {
        throw err;
      }

      await sleep(1_000); // the container is restarting; take the next running one
    }
  }
}

async function cameBack({ id, before }: { id: string; before: number }): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const [count, running] = sh(
      `docker inspect -f '{{.RestartCount}} {{.State.Running}}' ${id}`,
    ).split(' ');

    if (Number(count) > before && running === 'true') {
      return true;
    }

    await sleep(1_000);
  }

  return false;
}

const busy = (s: Summary) =>
  Object.values(s.operations).reduce((n, by) => n + (by.pending ?? 0) + (by.running ?? 0), 0);

interface DemoOptions {
  articles?: number;
  kills?: boolean;
  deadlineMinutes?: number;
  faultRate?: number;
}

export async function runDemo(options: DemoOptions = {}) {
  const stack = createDemoStack();

  try {
    return await run(stack, options);
  } finally {
    stack.cleanup();
  }
}

async function run(
  stack: ReturnType<typeof createDemoStack>,
  { articles = 300, kills = true, deadlineMinutes = 15, faultRate = 0.15 }: DemoOptions,
) {
  const sh = stack.command;

  const psql = (sql: string) =>
    sh(
      `docker compose exec -T postgres psql -U ryze -d ryze -v ON_ERROR_STOP=1 -tAF '|' -c "${sql}"`,
    );

  const failures: string[] = [];

  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);

    if (!ok) {
      failures.push(what);
    }
  };

  console.log('starting an isolated mock-only demo stack ...');
  sh(`docker compose up -d --build --wait ${SERVICES.join(' ')}`);
  const API = stack.endpoint('api', 8080);
  const PROVIDERS = stack.endpoint('mock-providers', 8091);
  const PLATFORMS = stack.endpoint('mock-wordpress', 8092);
  const faults = { rate: faultRate, kinds: ALL_FAULTS };
  await call('POST', `${PROVIDERS}/_admin/faults`, faults);
  const sites = [
    await registerMockSite(faults, { api: API, platforms: PLATFORMS }),
    await registerMockSite(faults, { api: API, platforms: PLATFORMS }),
  ];

  const items = Array.from({ length: articles }, (_, n) => ({
    site_id: sites[n % 2].id,
    brief: brief(n),
    idempotency_key: `demo-${n}`,
  }));

  const bulk = await call<{ results: { article_id: string; created: boolean }[] }>(
    'POST',
    `${API}/articles/bulk`,
    { items },
  );

  const ids = bulk.body.results.map((r) => r.article_id);
  check(
    bulk.status === 202 && bulk.body.results.every((r) => r.created),
    `bulk intake: ${articles} articles (${articles / 2} per site)`,
  );
  let same = 0;
  const repeats = Math.min(20, articles);

  for (let n = 0; n < repeats; n++) {
    const again = await call<{ article_id: string }>('POST', `${API}/articles`, items[n]);

    if (again.status === 200 && again.body.article_id === ids[n]) {
      same++;
    }
  }

  check(
    same === repeats,
    `the first ${repeats} posted again: ${same}/${repeats} answered 200 with the same id`,
  );

  const started = Date.now();
  const killAt = kills ? [20, 60] : [];
  const elapsed = () => (Date.now() - started) / 1000;
  // Paid calls a kill can cost: the text and image_submit operations still running right after
  // it (the dead worker's stay running until their leases expire).
  const inFlight = { text: 0, image_submit: 0 };
  const killed: { id: string; before: number }[] = [];
  let summary: Summary;

  for (;;) {
    while (killAt.length && elapsed() >= killAt[0]) {
      killAt.shift();
      const round = [await kill('worker-generate', sh), await kill('worker-publish', sh)];
      killed.push(...round);
      const [text, submits] = psql(
        `SELECT count(*) FILTER (WHERE step = 'text'), count(*) FILTER (WHERE step = 'image_submit')
         FROM operations WHERE status = 'running'`,
      ).split('|');
      inFlight.text += Number(text);
      inFlight.image_submit += Number(submits);
      const victims = round.map((k) => k.id.slice(0, 12)).join(', ');
      console.log(
        `t+${elapsed().toFixed(0)}s  kill -9: ${victims} (in flight: ${text} text, ${submits} image_submit)`,
      );
    }

    summary = (await call<Summary>('GET', `${API}/articles/summary`)).body;
    const open = busy(summary);
    console.log(
      `t+${elapsed().toFixed(0)}s  published ${summary.articles.published}/${articles}, ` +
        `operations pending or running: ${open}`,
    );

    if (open === 0 && !killAt.length) {
      break;
    }

    if (elapsed() > deadlineMinutes * 60) {
      const late = psql(
        `SELECT step || ' attempts ' || attempts || ', next try in ' ||
                greatest(0, round(EXTRACT(EPOCH FROM due_at - now()))) || ' s'
         FROM operations WHERE status IN ('pending', 'running') ORDER BY due_at LIMIT 5`,
      );
      console.log(`      still open (retry backoff): ${late.split('\n').join('; ')}`);
      check(false, `the pipeline drains within ${deadlineMinutes} minutes`);
      break;
    }

    const nextKill = killAt.length ? killAt[0] - elapsed() : 5;
    await sleep(Math.max(0.5, Math.min(5, nextKill)) * 1000);
  }

  const minutes = (elapsed() / 60).toFixed(1);

  if (kills) {
    const back = await Promise.all(killed.map(cameBack));
    check(
      back.every(Boolean),
      `every killed container was restarted by Compose (${killed.length})`,
    );
  }

  // What the platforms hold, before the reconciler has had any chance to clean up.
  const inspect = (await call<Inspect>('GET', `${PLATFORMS}/_admin/inspect`)).body;

  const recorded = new Map(
    psql('SELECT id, site_id, remote_media_id, remote_post_id, remote_url FROM articles')
      .split('\n')
      .map((line) => line.split('|'))
      .map(([id, siteId, mediaId, postId, url]) => [id, { siteId, mediaId, postId, url }]),
  );

  const ours = new Set(ids);
  const postsOf = new Map<string, number>();
  const mediaOf = new Map<string, number>();
  let live = 0;
  let drafts = 0;
  let unmarked = 0;
  let sharedSlugs = 0;
  let foreignMedia = 0;
  let consistent = 0;

  for (const site of inspect.sites.filter((s) => sites.some((d) => d.token === s.token))) {
    const registered = sites.find((d) => d.token === site.token);
    const siteId = registered?.id;
    const media = new Map(site.media.map((m) => [m.id, m.filename]));
    const slugs = new Set<string>();

    for (const p of site.posts) {
      if (p.status === 'live') {
        live++;
      } else {
        drafts++;
      }

      if (!p.article_id) {
        unmarked++;
      } else {
        postsOf.set(p.article_id, (postsOf.get(p.article_id) ?? 0) + 1);
      }

      if (slugs.has(p.slug)) {
        sharedSlugs++;
      }

      slugs.add(p.slug);
      // The article's own post, on its own site, with its own cover, as the database recorded it.
      const mine = p.article_id ? recorded.get(p.article_id) : undefined;

      if (
        mine &&
        mine.siteId === siteId &&
        mine.postId === p.id &&
        mine.mediaId === p.media_id &&
        mine.url === p.url &&
        media.get(p.media_id ?? '') === `ryze-${p.article_id}.jpg`
      ) {
        consistent++;
      }
    }

    for (const m of site.media) {
      const id = /^ryze-(.+)\.jpg$/.exec(m.filename)?.[1];

      if (id && ours.has(id) && recorded.get(id)?.siteId === siteId) {
        mediaOf.set(id, (mediaOf.get(id) ?? 0) + 1);
      } else {
        foreignMedia++;
      }
    }
  }

  const once = (m: Map<string, number>) => ids.filter((id) => m.get(id) === 1).length;
  const orphans = foreignMedia + [...mediaOf.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);

  check(summary.articles.published === articles, `${articles} articles published`);
  check(live === articles, `${articles} live posts on the platforms (found ${live})`);
  check(once(postsOf) === articles, 'exactly one post per article');
  check(unmarked === 0, 'every live post carries an article_id');
  check(sharedSlugs === 0, 'no two posts share a slug');
  check(drafts === 0, `zero drafts left (found ${drafts})`);
  console.log(`      media orphans: ${orphans}`);
  check(once(mediaOf) === articles && orphans === 0, 'exactly one media item per article');
  check(
    consistent === articles,
    `each post is its article's, on its site, with its cover, as recorded (${consistent})`,
  );

  console.log(
    'reconciler: docker compose run --rm --no-deps reconciler node dist/main.js --mode=reconcile',
  );
  const reconcileOut = sh(
    'docker compose run --rm --no-deps reconciler node dist/main.js --mode=reconcile',
  );

  const reportLine = reconcileOut.split('\n').find((l) => l.includes('"spend_usd"')) ?? '{}';
  const report = JSON.parse(reportLine);
  check(report.strays?.found === 0, `the reconciler finds no stray post (${report.strays?.found})`);

  // What the providers charged, and why anything beyond one call per article happened.
  const counters = (await call<Counters>('GET', `${PROVIDERS}/_admin/counters`)).body;

  const money = (calls: number, drops: number, running: number, what: string) => {
    const lost = calls - articles - drops;
    const bound = Math.min(running, kills ? GENERATE_CONCURRENCY * 2 : 0);
    console.log(
      `      ${what} = ${calls} = ${articles} articles + ${drops} complete_then_drop + ${lost} lost to kills (≤ ${bound} in flight)`,
    );
    check(lost >= 0 && lost <= bound, `${what}: every paid-twice call explained`);
  };
  money(counters.text_calls, counters.faults.text.complete_then_drop, inFlight.text, 'text_calls');
  money(
    counters.image_jobs,
    counters.faults.image_submit.complete_then_drop,
    inFlight.image_submit,
    'image_jobs',
  );

  const stuck = STEPS.reduce(
    (n, s) => n + (summary.operations[s]?.failed ?? 0) + (summary.operations[s]?.unknown ?? 0),
    0,
  );
  check(stuck === 0, 'no operation is failed or unknown');

  console.log('\noutcomes per step (attempts = failed attempts that were retried):');
  console.log('  step          succeeded  failed  unknown  attempts  max');
  const rows = psql(
    `SELECT step, count(*) FILTER (WHERE status = 'succeeded'), count(*) FILTER (WHERE status = 'failed'),
            count(*) FILTER (WHERE status = 'unknown'), sum(attempts), max(attempts)
     FROM operations GROUP BY step`,
  );

  const byStep = new Map(rows.split('\n').map((l) => [l.split('|')[0], l.split('|').slice(1)]));

  for (const s of STEPS) {
    const [ok, failed, unknown, attempts, max] = byStep.get(s) ?? ['0', '0', '0', '0', '0'];
    console.log(
      `  ${s.padEnd(13)} ${ok.padStart(9)} ${failed.padStart(7)} ${unknown.padStart(8)} ${attempts.padStart(9)} ${max.padStart(4)}`,
    );
  }

  console.log(
    `\nprovider spend $${counters.spend_usd.toFixed(4)}; recorded in operations.usage ` +
      `$${Number(report.spend_usd ?? 0).toFixed(4)}; drained in ${minutes} min`,
  );
  console.log(failures.length ? `\nDEMO FAILED: ${failures.join('; ')}` : '\nDEMO PASSED');

  return failures.length === 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const ok = await runDemo();
  process.exit(ok ? 0 : 1);
}
