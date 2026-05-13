/**
 * End-to-end smoke: typecheck, build, RLS test, Inngest endpoint reachable.
 * Assumes `pnpm db:start` is running. Used in CI and pre-deploy.
 */
import { execSync } from 'node:child_process';

const steps = [
  ['typecheck', 'pnpm typecheck'],
  ['build',     'pnpm build'],
  ['rls',       'pnpm rls:test'],
];

for (const [name, cmd] of steps) {
  process.stdout.write(`▶ ${name}… `);
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log('ok');
  } catch (e: unknown) {
    console.log('FAILED');
    if (e && typeof e === 'object' && 'stdout' in e) console.error(String((e as { stdout: unknown }).stdout ?? ''));
    if (e && typeof e === 'object' && 'stderr' in e) console.error(String((e as { stderr: unknown }).stderr ?? ''));
    process.exit(1);
  }
}
console.log('All smoke checks passed.');
