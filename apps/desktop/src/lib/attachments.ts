/** 附件模型：输入框上方的一排小卡片（T27） */
import type { FileId } from '../backend/types';

export type AttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface Attachment {
  /** 前端本地 id */
  localId: string;
  /** 后端分配；上传命令返回之前为空 */
  fileId?: FileId;
  name: string;
  size: number;
  kind: 'image' | 'file';
  /** 图片缩略图的 object URL（粘贴的图片才有） */
  previewUrl?: string;
  /** 发起上传命令就失败时的原因 */
  error?: string;
}

/** 后端上传进度（按 sessionId + fileId 记录） */
export interface UploadState {
  sent: number;
  total: number;
  done: boolean;
  remotePath?: string;
  failed?: string;
}

export function attachmentStatus(a: Attachment, u: UploadState | undefined): AttachmentStatus {
  if (a.error) return 'failed';
  if (!a.fileId) return 'uploading';
  if (!u) return 'uploading';
  if (u.failed) return 'failed';
  return u.done ? 'ready' : 'uploading';
}

export function attachmentProgress(a: Attachment, u: UploadState | undefined): number {
  if (!a.fileId || !u) return 0;
  if (u.done) return 1;
  return u.total > 0 ? Math.min(1, u.sent / u.total) : 0;
}

/** 有附件尚未就绪时不能提交 */
export function hasPendingAttachments(list: Attachment[], uploads: Record<string, UploadState>, sessionId: string): boolean {
  return list.some((a) => attachmentStatus(a, a.fileId ? uploads[`${sessionId}:${a.fileId}`] : undefined) !== 'ready');
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

export function pastedImageName(now: Date, ext = 'png'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `粘贴图片-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}
