/** Messages sent by the Admin shell to an embedded module. */
export type ShellFrameMessage =
  | { type: 'template.admin.theme'; theme: 'light' | 'dark' | 'system' }
  | { type: 'template.admin.navigate'; path: string };

/** Messages sent by an embedded module to the Admin shell. */
export type ChildFrameMessage =
  | { type: 'template.admin.path'; path: string }
  | { type: 'template.admin.ready' };
