import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeModulePath } from './protocol';
import { useModuleFrame } from './use-module-frame';

// A lifecycle host for the hook: the tests drive actual message handlers without a browser DOM.
const lifecycle = vi.hoisted(() => ({ effects: [] as (() => unknown)[] }));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => lifecycle.effects.push(effect),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, vi.fn()],
}));

beforeEach(() => { lifecycle.effects = []; });
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const contentWindow = { postMessage: vi.fn() };
  const onPathChange = vi.fn();
  const element = {
    contentWindow,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', {
    location: { origin: 'https://panel.test' },
    addEventListener: (type: string, callback: (event: MessageEvent) => void) => listeners.set(type, callback),
    removeEventListener: vi.fn(),
  });
  // eslint-disable-next-line react-hooks/rules-of-hooks -- This test supplies the mocked lifecycle host.
  useModuleFrame({
    frame: { current: element as unknown as HTMLIFrameElement },
    path: '/', theme: 'dark', onPathChange,
  });
  for (const effect of lifecycle.effects) effect();
  contentWindow.postMessage.mockClear();
  const receive = (origin: string, source: unknown, data: unknown) =>
    listeners.get('message')!({ origin, source, data } as MessageEvent);
  return { contentWindow, onPathChange, receive };
}

describe('Admin shell frame convention', () => {
  it('ignores messages from another origin or another iframe', () => {
    const { contentWindow, onPathChange, receive } = mount();
    const path = { type: 'template.admin.path', path: '/forged' };
    receive('https://other.test', contentWindow, path);
    receive('https://panel.test', {}, path);
    expect(onPathChange).not.toHaveBeenCalled();
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it('accepts a path only from its own embedded window', () => {
    const { contentWindow, onPathChange, receive } = mount();
    receive('https://panel.test', contentWindow, { type: 'template.admin.path', path: 'templates//42' });
    expect(onPathChange).toHaveBeenCalledWith('/templates/42');
  });

  it('answers a ready child with the current theme and an exact target origin', () => {
    const { contentWindow, receive } = mount();
    receive('https://panel.test', contentWindow, { type: 'template.admin.ready' });
    expect(contentWindow.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: 'template.admin.theme', theme: 'dark' }, 'https://panel.test',
    );
  });

  it('normalizes module-relative paths', () => {
    expect(normalizeModulePath('')).toBe('/');
    expect(normalizeModulePath('templates/1')).toBe('/templates/1');
    expect(normalizeModulePath('//templates//1')).toBe('/templates/1');
  });
});
