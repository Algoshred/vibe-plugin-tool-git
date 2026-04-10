/**
 * Type declarations for the vibe-plugin-git (Ungit) plugin.
 *
 * All interfaces are defined locally so the plugin does not hard-import
 * from the core agent package.  At runtime the host agent injects concrete
 * implementations via HostServices.
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";

// -- KV Storage provider ----------------------------------------------------

export interface StorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  keys(namespace: string): Promise<string[]>;
}

// -- Event bus ---------------------------------------------------------------

export interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

// -- Service registry --------------------------------------------------------

export interface ServiceRegistry {
  get<T = unknown>(name: string): T | undefined;
}

// -- Host services -----------------------------------------------------------

export interface HostServices {
  storage: StorageProvider;
  eventBus?: EventBus;
  serviceRegistry?: ServiceRegistry;
}

// -- Plugin contract ---------------------------------------------------------

export interface VibePlugin {
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  hasUI?: boolean;
  cliCommand?: string;
  apiPrefix?: string;
  publicPaths?: string[];
  onCliSetup?: (program: Command) => void | Promise<void>;
  onServerStart?: (
    app: Elysia,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerStop?: () => void | Promise<void>;
}

// -- Domain models -----------------------------------------------------------

export interface UngitStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  port?: number;
  workingDir?: string;
  error?: string;
}

// -- Request body shapes -----------------------------------------------------

export interface StartBody {
  workingDir?: string;
  port?: number;
}
