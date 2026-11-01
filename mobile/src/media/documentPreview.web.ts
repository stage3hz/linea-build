import { desktopBridge } from '../desktop';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { loadMedia } from './mediaCache';
export async function previewDocument(uri: string, _mime: string): Promise<boolean> { return desktopBridge()?.openFile(uri) || false; }
export async function openDocument(api: Api, file: Attachment): Promise<boolean> { return previewDocument(await loadMedia(api,file),file.mimeType); }
