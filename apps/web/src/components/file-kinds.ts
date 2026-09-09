import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react";

/*
 * What kind of file this is, in the two ways anything here needs to know.
 *
 * Lifted out of `AttachmentsField` when the library picker and the preview
 * window both needed the same answers. Three copies of "is this showable" is
 * three chances for a thumbnail, a tile and a preview to disagree about the
 * same file.
 */

/**
 * The icon for a file nobody can show a picture of.
 *
 * By media type first and by extension only as a fallback, because the media
 * type is what the file said about itself and an extension is what somebody
 * typed. Neither is trustworthy alone: a `.md` uploaded from a phone often
 * arrives as `application/octet-stream`, which would put a blank page beside
 * every note somebody moved across.
 */
export function iconFor(mime: string, filename: string) {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const is = (...xs: string[]) => xs.some((x) => mime.startsWith(x));
  if (is("audio/")) return FileAudio;
  if (is("video/")) return FileVideo;
  if (mime === "application/pdf" || ext === "pdf") return FileText;
  if (is("text/csv") || /^(csv|tsv|xls|xlsx|ods|numbers)$/.test(ext)) return FileSpreadsheet;
  if (/^(ppt|pptx|odp|key)$/.test(ext)) return Presentation;
  if (/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(ext)) return FileArchive;
  if (
    is("application/json", "application/xml", "text/html", "text/css", "text/javascript") ||
    /^(json|xml|ya?ml|toml|js|ts|tsx|jsx|py|rb|go|rs|swift|kt|java|c|h|cpp|sh)$/.test(ext)
  ) {
    return FileCode;
  }
  if (is("text/") || /^(md|markdown|txt|rtf|doc|docx|odt)$/.test(ext)) return FileText;
  return FileIcon;
}

/**
 * Whether the browser will draw this as a picture.
 *
 * Named formats rather than the whole of `image/*`: a TIFF or a HEIC is an
 * image the browser cannot render, and an `<img>` pointed at one shows a broken
 * icon — which reads as a damaged upload rather than as a format nothing here
 * can display. Those fall through to the icon, which is honest and looks
 * deliberate.
 */
export const SHOWABLE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp)$/;
