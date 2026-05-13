import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('RLS', () => {
  it('blocks cross-workspace reads and writes', () => {
    expect(() => execSync('pnpm rls:test', { stdio: 'pipe' })).not.toThrow();
  });
});
