export interface BskyAuthor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export interface BskyRecord {
  text?: string;
  createdAt?: string;
  reply?: {
    parent: { uri: string; cid: string };
    root: { uri: string; cid: string };
  };
}

export interface BskyEmbedImage {
  thumb: string;
  fullsize?: string;
  alt?: string;
}

export interface BskyEmbed {
  $type?: string;
  images?: BskyEmbedImage[];
}

export interface BskyPost {
  uri: string;
  cid?: string;
  author: BskyAuthor;
  record?: BskyRecord;
  embed?: BskyEmbed;
  indexedAt: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  matchedTerm?: string;
  matchedTerms?: string[];
}

export interface SearchResponse {
  posts: BskyPost[];
  cursor?: string;
}

export interface BskySession {
  accessJwt: string;
  refreshJwt: string;
  did?: string;
  handle?: string;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface DidCacheEntry {
  did: string;
  timestamp: number;
}

export interface ParsedPostUrl {
  actor: string;
  postId: string;
  rawHandle: string;
}

export type SortMode = 'top' | 'latest';
export type QuoteSortMode = 'likes' | 'recent' | 'oldest';
export type ThemePreference = 'light' | 'dark' | 'system';
