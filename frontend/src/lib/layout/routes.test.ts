import { describe, expect, it } from 'vitest';
import { hasShell, routes } from './routes';

describe('routes', () => {
  it('builds urls', () => {
    expect(routes.board('ENG', 'v1', 'ENG-42')).toBe('/b/ENG/v1?ticket=ENG-42');
    expect(routes.board('ENG')).toBe('/b/ENG');
    expect(routes.boardSettings('ENG')).toBe('/b/ENG/settings/general');
    // §Q2: People & roles is a section of board settings, not a place of its own.
    expect(routes.boardPeople('ENG')).toBe('/b/ENG/settings/people');
    // §Y3: Analytics is a section of board settings.
    expect(routes.boardAnalytics('ENG')).toBe('/b/ENG/settings/analytics');
    expect(routes.login('/me')).toBe('/login?next=%2Fme');
  });
  it('knows which screens have the shell', () => {
    expect(hasShell('/')).toBe(true);
    expect(hasShell('/b/ENG/v1')).toBe(true);
    expect(hasShell('/t/ENG-4')).toBe(false);
    expect(hasShell('/login')).toBe(false);
    expect(hasShell('/tokens')).toBe(true);
    // The file viewer page is full-window like /t (agents.html §I).
    expect(hasShell('/f/ENG/ENG-4/fi_1')).toBe(false);
    expect(hasShell('/agents')).toBe(true);
    expect(hasShell('/b/ENG/settings/analytics')).toBe(true);
  });
});
