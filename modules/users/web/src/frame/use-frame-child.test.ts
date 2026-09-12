import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFrameChild } from './use-frame-child';

const lifecycle = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  setters: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => lifecycle.effects.push(effect),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    lifecycle.setters.push(setter);
    return [typeof initial === 'function' ? initial() : initial, setter];
  },
}));

beforeEach(() => { lifecycle.effects = []; lifecycle.setters = []; });
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const parent = { postMessage: vi.fn() };
  const onNavigate = vi.fn();
  vi.stubGlobal('window', {
    parent,
    location: { origin: 'https://panel.test' },
    addEventListener: (type: string, callback: (event: MessageEvent) => void) => listeners.set(type, callback),
    removeEventListener: vi.fn(),
  });
  // eslint-disable-next-line react-hooks/rules-of-hooks -- This test supplies the mocked lifecycle host.
  useFrameChild({ path: 'items//42', onNavigate });
  for (const effect of lifecycle.effects) effect();
  const receive = (origin: string, source: unknown, data: unknown) =>
    listeners.get('message')!({ origin, source, data } as MessageEvent);
  return { parent, onNavigate, receive, setTheme: lifecycle.setters[1]! };
}

describe('Module iframe convention', () => {
  it('announces readiness and its path only to the same-origin parent', () => {
    const { parent } = mount();
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: 'template.admin.ready' }, 'https://panel.test'],
      [{ type: 'template.admin.path', path: '/items/42' }, 'https://panel.test'],
    ]);
  });

  it('ignores navigation from another origin or another window', () => {
    const { parent, onNavigate, receive } = mount();
    const message = { type: 'template.admin.navigate', path: '/forged' };
    receive('https://other.test', parent, message);
    receive('https://panel.test', {}, message);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('ignores malformed navigation without breaking later messages', () => {
    const { parent, onNavigate, receive } = mount();
    for (const path of [undefined, null, 42, true, {}, []]) {
      expect(() => receive('https://panel.test', parent, { type: 'template.admin.navigate', path })).not.toThrow();
    }
    expect(onNavigate).not.toHaveBeenCalled();
    receive('https://panel.test', parent, { type: 'template.admin.navigate', path: '/valid' });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('/valid');
  });

  it('accepts the parent route and only recognized theme preferences', () => {
    const { parent, onNavigate, receive, setTheme } = mount();
    receive('https://panel.test', parent, { type: 'template.admin.navigate', path: 'items//7' });
    expect(onNavigate).toHaveBeenCalledWith('/items/7');
    receive('https://panel.test', parent, { type: 'template.admin.theme', theme: 'invalid' });
    expect(setTheme).not.toHaveBeenCalled();
    receive('https://panel.test', parent, { type: 'template.admin.theme', theme: 'system' });
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('system');
  });
});
