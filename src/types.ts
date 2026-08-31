export interface VaultConfig {
  vaultPath: string;
  allowedSubpaths?: string[];
  readOnly?: boolean;
  transport?: 'stdio' | 'sse' | 'http';
  port?: number;
  host?: string;
}

export interface NoteMetadata {
  path: string;
  title: string;
  frontmatter: Record<string, any>;
  tags: string[];
  wikilinks: string[];
  backlinks?: string[];
  mtime: number;
  size: number;
}

export interface NoteContent {
  path: string;
  rawContent: string;
  frontmatter: Record<string, any>;
  body: string;
  metadata: NoteMetadata;
}

export interface SearchOptions {
  query?: string;
  tags?: string[];
  frontmatterFilter?: Record<string, any>;
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  path: string;
  title: string;
  matchedContent?: string;
  score?: number;
  tags: string[];
  frontmatter: Record<string, any>;
}

export interface GraphNode {
  id: string; // relative path
  title: string;
  tags: string[];
  links: string[]; // outgoing target relative paths or note titles
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'wikilink' | 'frontmatter_rel' | 'tag_cluster';
}

export interface WorkspaceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: string[];
  danglingLinks: { source: string; targetTitle: string }[];
}

export interface TaskItem {
  path: string;
  line: number;
  completed: boolean;
  text: string;
  statusTag?: string; // e.g. [ ] / [x] / [/] / [-]
}

export interface FolderNode {
  path: string; // relative path from vault root
  name: string;
  subfolders: string[];
  notesCount: number;
}

export interface VaultTreeNode {
  name: string;
  path: string;
  type: 'folder' | 'note' | 'file';
  size?: number;
  mtime?: number;
  children?: VaultTreeNode[];
}
