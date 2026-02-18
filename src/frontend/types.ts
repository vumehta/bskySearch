export type SearchSort = 'top' | 'latest';
export type QuoteSort = 'likes' | 'recent' | 'oldest';
export type ThemePreference = 'light' | 'dark' | 'system';

export interface Author {
  handle: string;
  displayName?: string;
  avatar?: string;
}

export interface ReplyRef {
  root?: unknown;
  parent?: unknown;
}

export interface PostRecord {
  text?: string;
  createdAt?: string;
  reply?: ReplyRef;
}

export interface PostImage {
  thumb?: string;
  alt?: string;
}

export interface PostEmbedImagesView {
  $type: 'app.bsky.embed.images#view';
  images?: PostImage[];
}

export interface Post {
  uri: string;
  author: Author;
  record?: PostRecord;
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  embed?: PostEmbedImagesView | Record<string, unknown>;
  matchedTerm?: string;
  matchedTerms?: string[];
}

export interface SearchResponse {
  posts: Post[];
  cursor: string | null;
}

export interface QuotePage {
  posts: Post[];
  cursor: string | null;
}

export interface ThreadState {
  loading: boolean;
  visible: boolean;
  parents: Post[];
  message: string | null;
}

export interface StatusMessage {
  type: 'info' | 'error' | 'loading';
  message: string;
}
