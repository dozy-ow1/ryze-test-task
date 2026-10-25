// The acceptance run. 300 articles over two sites whose platforms fail 15 % of writes, providers
// failing 15 % of paid calls, two kill -9 rounds of the workers; then every article must be live
// exactly once, with its image, and every extra provider charge must be explained.
//
//   pnpm demo              (E2E=1 pnpm test runs the same with 50 articles and no kills)
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ALL_FAULTS, API, brief, call, PLATFORMS, PROVIDERS, registerFakeSite } from './lib.js';

const SERVICES = [
  'postgres',
  'minio',
  'fake-providers',
  'fake-platforms',
  'api',
  'worker-generate',
  'worker-publish',
  'reconciler',
];
const GENERATE_CONCURRENCY = 8; // worker-generate's CONCURRENCY in docker-compose.yml
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
    posts: { id: string; slug: string; status: string; article_id: string | null }[];
  }[];
};

const sh = (cmd: string) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const psql = (sql: string) =>
  sh(
    `docker compose exec -T postgres psql -U ryze -d ryze -v ON_ERROR_STOP=1 -tAF '|' -c "${sql}"`,
  );

// SIGKILL the worker process inside the container: it dies like a crash, Compose restarts it.
function kill(service: string): string {
  const id = sh(`docker compose ps -q ${service}`).split('\n')[0];
  sh(`docker exec ${id} sh -c 'kill -9 $(pidof node)'`);
  return id.slice(0, 12);
}

const busy = (s: Summary) =>
  Object.values(s.operations).reduce((n, by) => n + (by.pending ?? 0) + (by.running ?? 0), 0);

export async function runDemo({ articles = 300, kills = true, deadlineMinutes = 15 } = {}) {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
    if (!ok) failures.push(what);
  };

  if (!existsSync('.env')) copyFileSync('.env.example', '.env');
  console.log('starting the stack (docker compose up -d --build --wait) ...');
  sh(`docker compose up -d --build --wait ${SERVICES.join(' ')}`);

  // A clean slate: the demo's assertions count everything in the database and in the fakes.
  psql(
    `TRUNCATE operations, articles, sites, batches RESTART IDENTITY CASCADE;
     DELETE FROM quotas WHERE scope LIKE 'site:%';
     UPDATE quotas SET tokens = capacity, tokens_at = now(), failures = 0, open_until = NULL;`,
  );
  await call('POST', `${PROVIDERS}/_admin/reset`);
  await call('POST', `${PLATFORMS}/_admin/reset`);
  const faults = { rate: 0.15, kinds: ALL_FAULTS };
  await call('POST', `${PROVIDERS}/_admin/faults`, faults);
  const sites = [
    await registerFakeSite('wordpress', faults),
    await registerFakeSite('shopify', faults),
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
  for (let n = 0; n < 20; n++) {
    const again = await call<{ article_id: string }>('POST', `${API}/articles`, items[n]);
    if (again.status === 200 && again.body.article_id === ids[n]) same++;
  }
  check(same === 20, `the first 20 posted again: ${same}/20 answered 200 with the same id`);

  const started = Date.now();
  const killAt = kills ? [20, 60] : [];
  const elapsed = () => (Date.now() - started) / 1000;
  let summary: Summary;
  for (;;) {
    while (killAt.length && elapsed() >= killAt[0]) {
      killAt.shift();
      const victims = ['worker-generate', 'worker-publish'].map((s) => `${s} ${kill(s)}`);
      console.log(`t+${elapsed().toFixed(0)}s  kill -9: ${victims.join(', ')}`);
    }
    summary = (await call<Summary>('GET', `${API}/articles/summary`)).body;
    const open = busy(summary);
    console.log(
      `t+${elapsed().toFixed(0)}s  published ${summary.articles.published}/${articles}, ` +
        `operations pending or running: ${open}`,
    );
    if (open === 0 && !killAt.length) break;
    if (elapsed() > deadlineMinutes * 60) {
      check(false, `the pipeline drains within ${deadlineMinutes} minutes`);
      break;
    }
    const nextKill = killAt.length ? killAt[0] - elapsed() : 5;
    await sleep(Math.max(0.5, Math.min(5, nextKill)) * 1000);
  }
  const minutes = (elapsed() / 60).toFixed(1);

  console.log('reconciler: docker compose run --rm reconciler node dist/main.js --mode=reconcile');
  const reconcileOut = sh('docker compose run --rm reconciler node dist/main.js --mode=reconcile');
  const reportLine = reconcileOut.split('\n').find((l) => l.includes('"spend_usd"')) ?? '{}';
  const report = JSON.parse(reportLine);

  // What the platforms hold.
  const inspect = (await call<Inspect>('GET', `${PLATFORMS}/_admin/inspect`)).body;
  const ours = new Set(ids);
  const postsOf = new Map<string, number>();
  const mediaOf = new Map<string, number>();
  let live = 0;
  let drafts = 0;
  let unmarked = 0;
  let sharedSlugs = 0;
  let foreignMedia = 0;
  for (const site of inspect.sites.filter((s) => sites.some((d) => d.token === s.token))) {
    const slugs = new Set<string>();
    for (const p of site.posts) {
      if (p.status === 'live') live++;
      else drafts++;
      if (!p.article_id) unmarked++;
      else postsOf.set(p.article_id, (postsOf.get(p.article_id) ?? 0) + 1);
      if (slugs.has(p.slug)) sharedSlugs++;
      slugs.add(p.slug);
    }
    for (const m of site.media) {
      const id = /^ryze-(.+)\.jpg$/.exec(m.filename)?.[1];
      if (id && ours.has(id)) mediaOf.set(id, (mediaOf.get(id) ?? 0) + 1);
      else foreignMedia++;
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

  // What the providers charged, and why anything beyond one call per article happened.
  const counters = (await call<Counters>('GET', `${PROVIDERS}/_admin/counters`)).body;
  const bound = kills ? GENERATE_CONCURRENCY * 2 : 0;
  const money = (calls: number, drops: number, what: string) => {
    const killed = calls - articles - drops;
    console.log(
      `      ${what} = ${calls} = ${articles} articles + ${drops} complete_then_drop + ${killed} lost to kills`,
    );
    check(killed >= 0 && killed <= bound, `${what}: paid-twice calls explained (kills ≤ ${bound})`);
  };
  money(counters.text_calls, counters.faults.text.complete_then_drop, 'text_calls');
  money(counters.image_jobs, counters.faults.image_submit.complete_then_drop, 'image_jobs');

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
      `$${Number(report.spend_usd ?? 0).toFixed(4)}; stray drafts deleted by the reconciler: ` +
      `${report.strays?.deleted ?? 'n/a'}; drained in ${minutes} min`,
  );
  console.log(failures.length ? `\nDEMO FAILED: ${failures.join('; ')}` : '\nDEMO PASSED');
  return failures.length === 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const ok = await runDemo();
  process.exit(ok ? 0 : 1);
}
