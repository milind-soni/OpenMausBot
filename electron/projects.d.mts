import type { ProjectRecord } from "../src/types/gbs";

export class ProjectService {
  constructor(options: { dataDir: string; filePath?: string });
  list(): Promise<ProjectRecord[]>;
  addExisting(projectPath: string): Promise<ProjectRecord>;
  createProject(input: { parentPath: string; name: string; allowedRoot?: string }): Promise<ProjectRecord>;
  cloneProject(input: { repositoryUrl: string; destinationPath: string; allowedRoot?: string }): Promise<ProjectRecord>;
}
