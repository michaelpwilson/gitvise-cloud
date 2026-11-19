import {
  BLOB_ENCODINGS,
  GitViseError,
  type BlobEncoding,
  type BlobInfo,
  type BlobKind,
  type BlobRef,
  type BlobStoragePort,
  type BlobWriteOptions,
} from '@gitvise/core';
import { errorMessage, upstreamError } from '../shared/errors';
import { isSha256Hex } from '../shared/bytes';

/** R2 error text for a digest or length mismatch. Anything else is treated as an upstream failure. */
const INTEGRITY_ERROR = /checksum|digest|sha256|length|size/i;

/**
 * `BlobStoragePort` over an R2 bucket. Blobs are content-addressed: the key is `kind/sha256`, and R2
 * verifies the SHA-256 digest on write. Writes stream through a `FixedLengthStream`, which R2 needs
 * to know the size up front, so nothing is buffered in the Worker.
 */
export class CloudflareR2BlobStorageAdapter implements BlobStoragePort {
  constructor(private readonly bucket: R2Bucket) {}

  async putBlob(ref: BlobRef, body: ReadableStream<Uint8Array>, options: BlobWriteOptions): Promise<boolean> {
    assertRef(ref);
    assertWriteOptions(options);
    const key = keyFor(ref);

    if ((await this.bucket.head(key)) !== null) {
      await body.cancel();
      return false;
    }

    const fixed = new FixedLengthStream(options.byteLength);
    const piping = body.pipeTo(fixed.writable);
    const writing = this.bucket.put(key, fixed.readable, {
      sha256: ref.sha256,
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        kind: ref.kind,
        encoding: options.encoding,
        byteLength: String(options.byteLength),
      },
    });

    const [pipeResult, writeResult] = await Promise.allSettled([piping, writing]);
    if (writeResult.status === 'rejected') throw classifyWriteError(ref, writeResult.reason);
    if (pipeResult.status === 'rejected') throw classifyWriteError(ref, pipeResult.reason);
    return writeResult.value !== null;
  }

  async getBlob(ref: BlobRef): Promise<{ readonly info: BlobInfo; readonly body: ReadableStream<Uint8Array> } | undefined> {
    assertRef(ref);
    const object = await this.bucket.get(keyFor(ref));
    if (object === null || !('body' in object)) return undefined;
    return { info: infoFrom(ref, object.customMetadata), body: object.body };
  }

  async headBlob(ref: BlobRef): Promise<BlobInfo | undefined> {
    assertRef(ref);
    const object = await this.bucket.head(keyFor(ref));
    if (object === null) return undefined;
    return infoFrom(ref, object.customMetadata);
  }
}

function keyFor(ref: BlobRef): string {
  return `${ref.kind}/${ref.sha256}`;
}

function assertRef(ref: BlobRef): void {
  if (!isBlobKind(ref.kind)) throw new GitViseError('INVALID_REQUEST', 'blob kind is not supported');
  if (!isSha256Hex(ref.sha256)) throw new GitViseError('INVALID_REQUEST', 'blob sha256 must be lowercase hex');
}

function assertWriteOptions(options: BlobWriteOptions): void {
  if (!Number.isSafeInteger(options.byteLength) || options.byteLength < 0) {
    throw new GitViseError('INVALID_REQUEST', 'byteLength must be a non-negative integer');
  }
  if (!isBlobEncoding(options.encoding)) throw new GitViseError('INVALID_REQUEST', 'encoding is not supported');
}

function infoFrom(ref: BlobRef, metadata: Record<string, string> | undefined): BlobInfo {
  const encoding = metadata?.['encoding'];
  const byteLength = Number(metadata?.['byteLength']);
  if (!isBlobEncoding(encoding) || !Number.isSafeInteger(byteLength)) {
    throw upstreamError(`blob ${ref.sha256} has corrupt metadata`);
  }
  return { kind: ref.kind, sha256: ref.sha256, encoding, byteLength };
}

function classifyWriteError(ref: BlobRef, error: unknown): GitViseError {
  const message = errorMessage(error);
  if (INTEGRITY_ERROR.test(message)) {
    return new GitViseError('INVALID_REQUEST', `blob ${ref.sha256} was rejected: ${message}`);
  }
  return upstreamError(`writing blob ${ref.sha256} failed`, error);
}

function isBlobKind(value: string): value is BlobKind {
  return value === 'packfile' || value === 'lfs-object';
}

function isBlobEncoding(value: unknown): value is BlobEncoding {
  return typeof value === 'string' && (BLOB_ENCODINGS as readonly string[]).includes(value);
}
