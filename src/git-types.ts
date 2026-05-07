/**
 * Types for the merged "git" repository tracker routes.
 *
 * The plugin already exposes Ungit (visual git client). The agent's
 * built-in `git` plugin (which scans / tracks / hierarchy-manages the
 * user's git repos) is now also merged into this package; this file
 * declares the structural surfaces those routes need.
 */

export interface GitRepository {
  id: string;
  path: string;
  name: string;
  parentPath?: string;
  isSubmodule: boolean;
  projectType?: string;
  vitePort?: number;
  lastScanned: string;
  createdAt: string;
}

/**
 * Subset of AgentDatabase methods the git tracker routes use.
 */
export interface GitAgentDatabase {
  getAllGitRepositories(): Promise<GitRepository[]>;
  getGitRepository(id: string): Promise<GitRepository | null>;
  getGitRepositoryByPath(path: string): Promise<GitRepository | null>;
  createGitRepository(
    repo: Omit<GitRepository, "createdAt" | "lastScanned"> & {
      createdAt?: string;
      lastScanned?: string;
    },
  ): Promise<GitRepository>;
  updateGitRepository(
    id: string,
    updates: Partial<GitRepository>,
  ): Promise<void>;
  deleteGitRepository(id: string): Promise<void>;
  fixGitHierarchy(): Promise<{ fixed: number }>;
}

export interface GitServiceRegistryLike {
  getProvider<T>(type: string): T | undefined;
  getProviderByName?<T>(type: string, name: string): T | undefined;
  listProvidersForType?(
    type: string,
  ): Array<{ pluginName: string; isDefault: boolean }>;
}

export interface GitPluginRouteDeps {
  db: GitAgentDatabase;
  serviceRegistry: GitServiceRegistryLike;
}
