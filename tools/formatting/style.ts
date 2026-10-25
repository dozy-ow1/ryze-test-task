import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

// Biome formats the body; our two project conventions keep imports on one line and
// separate control flow, async work and returns from surrounding statement groups.
const write = process.argv.includes('--write');

const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'utf8',
});

if (tracked.status !== 0) {
  throw new Error(tracked.stderr);
}

const files = [...new Set(tracked.stdout.split('\0'))].filter(
  (file) => /\.(?:[cm]?[jt]s|json)$/.test(file) && existsSync(file),
);

const temporary = mkdtempSync(join(tmpdir(), 'ryze-style-'));
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
let failed = false;

try {
  for (const [file, source] of sources) {
    const target = join(temporary, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  // Format a temporary tree in one process. Checking never rewrites the working tree.
  const formatted = spawnSync(
    'node_modules/.bin/biome',
    ['format', '--write', '--config-path', resolve('biome.json'), temporary],
    { encoding: 'utf8' },
  );

  if (formatted.status !== 0) {
    throw new Error(formatted.stderr || formatted.stdout);
  }

  for (const [file, source] of sources) {
    const formattedSource = readFileSync(join(temporary, file), 'utf8');

    const expected = /\.[cm]?[jt]s$/.test(file)
      ? applyStyle(formattedSource, file)
      : formattedSource;

    if (source === expected) {
      continue;
    }

    if (write) {
      writeFileSync(file, expected);
    } else {
      console.error(`${file}: run pnpm format`);
      failed = true;
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;

function applyStyle(source: string, filename: string): string {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];

  const control = (node: ts.Node) =>
    ts.isIfStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isTryStatement(node) ||
    ts.isSwitchStatement(node);

  const awaited = (node: ts.Node): boolean =>
    ts.isAwaitExpression(node) || ts.forEachChild(node, awaited) === true;

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      edits.push({
        start: node.getStart(tree),
        end: node.end,
        text: node.getText(tree).replace(/\s+/g, ' ').replace(/,\s*}/g, ' }'),
      });
    }

    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isObjectLiteralExpression(node)) {
      const statements = ts.isObjectLiteralExpression(node) ? node.properties : node.statements;

      for (let index = 1; index < statements.length; index++) {
        const previous = statements[index - 1];
        const current = statements[index];
        const declarations = ts.isVariableStatement(previous) && ts.isVariableStatement(current);

        const complexDeclarations =
          declarations &&
          [previous, current].some(
            (statement) => awaited(statement) || statement.getText(tree).includes('\n'),
          );

        const handler =
          ts.isMethodDeclaration(current) ||
          (ts.isPropertyAssignment(current) && ts.isArrowFunction(current.initializer));

        const separated =
          handler ||
          control(previous) ||
          control(current) ||
          ts.isReturnStatement(current) ||
          ts.isThrowStatement(current) ||
          (!ts.isImportDeclaration(current) && ts.isImportDeclaration(previous)) ||
          complexDeclarations;

        if (!separated) {
          continue;
        }

        const comment = ts.getLeadingCommentRanges(source, current.getFullStart())?.[0];
        const start = comment?.pos ?? current.getStart(tree);
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;

        if (lineStart > previous.end && !/\n\s*\n/.test(source.slice(previous.end, lineStart))) {
          edits.push({ start: lineStart, end: lineStart, text: '\n' });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(tree);

  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }

  return source;
}
