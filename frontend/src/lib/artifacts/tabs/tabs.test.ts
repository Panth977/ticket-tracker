import { describe, expect, it } from 'vitest';
import { ARTIFACT_TABS, artifactTabHref, parseArtifactTab, withParams } from './index';

describe('artifact host tabs', () => {
  it('?tab= picks a known tab; anything else is the website', () => {
    expect(parseArtifactTab('db').id).toBe('db');
    expect(parseArtifactTab(null).id).toBe('website');
    expect(parseArtifactTab('nope').id).toBe('website');
    expect(ARTIFACT_TABS.filter((t) => t.data).map((t) => t.id)).toEqual(['code', 'db', 'json']);
  });

  it('a tab link keeps the path (owner-first too) and drops the other tabs’ parameters', () => {
    const at = new URL('https://app.test/acme/x/sales?tab=bucket&bucket=b1&path=docs/a.md&full=1');
    expect(artifactTabHref(at, 'db')).toBe('/acme/x/sales?full=1&tab=db');
    expect(artifactTabHref(at, 'website')).toBe('/acme/x/sales?full=1');
    expect(withParams(at, { path: null, bucket: 'b2' })).toBe(
      '/acme/x/sales?tab=bucket&bucket=b2&full=1',
    );
  });
});
