export type MusicTrack = {
  id: string;
  source: 'audius' | 'soundcloud' | 'local';
  sourceId?: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  duration: number;
  genre?: string;
  mood?: string;
  sourceUrl?: string;
  downloadable: boolean;
  localUri?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  savedAt?: string;
};

export type MusicSource = 'soundcloud' | 'audius';

export type MusicSearch = {
  query?: string;
  mood?: string;
  downloadableOnly?: boolean;
  offset?: number;
  limit?: number;
};

export type MusicSearchResult = {
  tracks: MusicTrack[];
  nextOffset: number | null;
};

export type MusicMedia = {
  uri: string;
  fileName?: string;
  mimeType?: string;
};

export type MusicMood = {
  id: string;
  label: string;
  icon: string;
  apiMood?: string;
};
