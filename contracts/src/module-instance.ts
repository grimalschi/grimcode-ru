/** The ready module returned by createModule; settings are already captured. */
export interface ModuleInstance<Api = unknown> {
  id: string;
  publicFetch?: (request: Request) => Response | Promise<Response>;
  adminFetch?: (request: Request) => Response | Promise<Response>;
  internalCaller?: Api;
  admin?: {
    title: string;
    /** Lucide icon ID in kebab-case, for example "mail". */
    icon: string;
    /** Defaults to true. False makes the embedded module available only to the owner. */
    assignable?: boolean;
  };
  /** Prepares this module's own storage before the application accepts requests. */
  migrate?: () => Promise<void>;
}
