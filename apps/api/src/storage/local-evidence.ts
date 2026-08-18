import type { MultipartFile } from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EvidenceFile } from "../domain/types.js";

const mimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const uploadRoot = process.env.UPLOAD_DIR ?? join(process.cwd(), "data", "uploads");

export async function saveEvidenceFile(
  part: MultipartFile,
  taskId: string,
  uploadedBy: string,
  purpose: EvidenceFile["purpose"] = "INSPECTION",
  metadata: Partial<Pick<EvidenceFile, "sampleKey" | "latitude" | "longitude" | "accuracy" | "address" | "coordinateSystem" | "mapProvider" | "capturedAt" | "watermarkText" | "watermarkVersion">> = {},
): Promise<EvidenceFile> {
  const extension = mimeExtensions[part.mimetype];
  if (!extension) throw new Error("只允许上传 JPG、PNG 或 WebP 现场照片");

  const id = randomUUID();
  const storageKey = `${taskId}/${id}${extension}`;
  const fullPath = join(uploadRoot, taskId, `${id}${extension}`);
  await mkdir(dirname(fullPath), { recursive: true });

  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(part.file, meter, createWriteStream(fullPath, { flags: "wx" }));
    if (part.file.truncated) throw new Error("照片超过10MB限制");
  } catch (error) {
    await unlink(fullPath).catch(() => undefined);
    throw error;
  }

  return {
    id,
    taskId,
    purpose,
    ...metadata,
    fileName: basename(part.filename || `evidence${extension}`).slice(0, 160),
    mimeType: part.mimetype,
    size,
    storageKey,
    sha256: hash.digest("hex"),
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  };
}

export function openEvidenceFile(storageKey: string) {
  const normalized = storageKey.replaceAll("\\", "/");
  if (normalized.includes("..") || normalized.startsWith("/")) throw new Error("无效的文件路径");
  return createReadStream(join(uploadRoot, ...normalized.split("/")));
}
